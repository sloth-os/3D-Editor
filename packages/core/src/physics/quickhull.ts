import type { Vec3 } from '../math/types';
import { sphereDirections } from './vmath';

/*
 * 3D convex hull (Quickhull). Faces are found as triangles and coplanar neighbours are merged
 * into convex polygons afterwards, so a cube yields 6 quads and a cylinder two n-gon caps.
 * Degenerate inputs (single point, collinear or coplanar points) are reported through
 * `dimension` instead of failing. The algorithm is deterministic (no randomisation).
 */

export interface ConvexHull {
  /** Hull vertices, flat xyz. */
  points: number[];
  /** Polygons indexing `points`, counter-clockwise seen from outside. */
  faces: number[][];
  /** Outward unit normal and offset (n · p = d) of each face. */
  normals: Vec3[];
  offsets: number[];
  /**
   * Affine dimension of the input: 0 = one point, 1 = segment (`points` holds both ends),
   * 2 = flat polygon (two opposite faces), 3 = solid.
   */
  dimension: 0 | 1 | 2 | 3;
}

interface HullFace {
  v: [number, number, number];
  nx: number;
  ny: number;
  nz: number;
  d: number;
  /** Neighbour across edge i (v[i] → v[i+1]). */
  nb: [number, number, number];
  outside: number[];
  far: number;
  farDist: number;
  alive: boolean;
  stamp: number;
}

/**
 * Convex hull of a point cloud (flat xyz; non-finite points are ignored). Hulls with more than
 * `maxVertices` vertices are simplified to the extreme points along a fixed set of directions,
 * which keeps the result inside the exact hull. Returns null for an empty input.
 */
export function convexHull(input: ArrayLike<number>, maxVertices = Infinity): ConvexHull | null {
  const pts: number[] = [];
  for (let i = 0; i + 2 < input.length; i += 3) {
    const x = input[i];
    const y = input[i + 1];
    const z = input[i + 2];
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) pts.push(x, y, z);
  }
  if (pts.length === 0) return null;
  let hull = hullOf(pts);
  const limit = Math.max(4, Math.floor(maxVertices));
  if (hull.dimension === 3 && hull.points.length / 3 > limit) {
    const reduced: number[] = [];
    const seen = new Set<number>();
    const hp = hull.points;
    for (const [dx, dy, dz] of sphereDirections(limit)) {
      let best = -1;
      let bestDot = -Infinity;
      for (let i = 0; i < hp.length; i += 3) {
        const d = hp[i] * dx + hp[i + 1] * dy + hp[i + 2] * dz;
        if (d > bestDot) {
          bestDot = d;
          best = i;
        }
      }
      if (best >= 0 && !seen.has(best)) {
        seen.add(best);
        reduced.push(hp[best], hp[best + 1], hp[best + 2]);
      }
    }
    const simplified = hullOf(reduced);
    if (simplified.dimension === 3) hull = simplified;
  }
  return hull;
}

function hullOf(p: number[]): ConvexHull {
  const n = p.length / 3;
  let maxAbs = 0;
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  const loI = [0, 0, 0];
  const hiI = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const v = p[i * 3 + a];
      if (v < lo[a]) {
        lo[a] = v;
        loI[a] = i;
      }
      if (v > hi[a]) {
        hi[a] = v;
        hiI[a] = i;
      }
      maxAbs = Math.max(maxAbs, Math.abs(v));
    }
  }
  const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  // tolerance for float32-sourced mesh data: coplanar / duplicate points within eps are merged
  const eps = Math.max(3 * Number.EPSILON * 3 * maxAbs, 1e-7 * extent, 1e-12);
  const P = (i: number): Vec3 => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];

  // ---- initial simplex
  let axis = 0;
  for (let a = 1; a < 3; a++) if (hi[a] - lo[a] > hi[axis] - lo[axis]) axis = a;
  const i0 = loI[axis];
  const i1 = hiI[axis];
  if (extent <= eps) return { points: P(i0), faces: [], normals: [], offsets: [], dimension: 0 };
  const p0 = P(i0);
  const p1 = P(i1);
  const dir = sub(p1, p0);
  let i2 = -1;
  let best = 0;
  for (let i = 0; i < n; i++) {
    const c = cross(dir, sub(P(i), p0));
    const d = Math.hypot(c[0], c[1], c[2]);
    if (d > best) {
      best = d;
      i2 = i;
    }
  }
  const dirLen = Math.hypot(dir[0], dir[1], dir[2]);
  if (i2 < 0 || best / dirLen <= eps)
    return { points: [...p0, ...p1], faces: [], normals: [], offsets: [], dimension: 1 };
  const p2 = P(i2);
  const pn = normalize(cross(dir, sub(p2, p0)));
  let i3 = -1;
  best = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(dot(pn, sub(P(i), p0)));
    if (d > best) {
      best = d;
      i3 = i;
    }
  }
  if (i3 < 0 || best <= eps) return planarHull(p, pn, p0, dir, eps);

  // ---- tetrahedron
  const faces: HullFace[] = [];
  const centroid = scale(add(add(p0, p1), add(p2, P(i3))), 0.25);
  const makeFace = (a: number, b: number, c: number): HullFace => {
    const pa = P(a);
    const nrm = cross(sub(P(b), pa), sub(P(c), pa));
    const l = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1;
    const nx = nrm[0] / l;
    const ny = nrm[1] / l;
    const nz = nrm[2] / l;
    return {
      v: [a, b, c],
      nx,
      ny,
      nz,
      d: nx * pa[0] + ny * pa[1] + nz * pa[2],
      nb: [-1, -1, -1],
      outside: [],
      far: -1,
      farDist: 0,
      alive: true,
      stamp: 0,
    };
  };
  for (const [a, b, c] of [
    [i0, i1, i2],
    [i0, i1, i3],
    [i0, i2, i3],
    [i1, i2, i3],
  ]) {
    let f = makeFace(a, b, c);
    if (f.nx * centroid[0] + f.ny * centroid[1] + f.nz * centroid[2] - f.d > 0) f = makeFace(a, c, b);
    faces.push(f);
  }
  linkNeighbours(faces, n);
  const dist = (f: HullFace, i: number) => f.nx * p[i * 3] + f.ny * p[i * 3 + 1] + f.nz * p[i * 3 + 2] - f.d;
  const assign = (i: number, candidates: number[]) => {
    let bestF = -1;
    let bestD = eps;
    for (const fi of candidates) {
      const d = dist(faces[fi], i);
      if (d > bestD) {
        bestD = d;
        bestF = fi;
      }
    }
    if (bestF >= 0) {
      const f = faces[bestF];
      f.outside.push(i);
      if (bestD > f.farDist) {
        f.farDist = bestD;
        f.far = i;
      }
    }
  };
  const initial = [0, 1, 2, 3];
  for (let i = 0; i < n; i++) if (i !== i0 && i !== i1 && i !== i2 && i !== i3) assign(i, initial);

  // ---- main loop
  const queue: number[] = initial.filter((fi) => faces[fi].outside.length > 0);
  let stamp = 0;
  let qi = 0;
  const maxIterations = 4 * n + 16;
  for (let iter = 0; qi < queue.length && iter < maxIterations; iter++) {
    const fi = queue[qi++];
    const start = faces[fi];
    if (!start.alive || start.outside.length === 0) continue;
    const eye = start.far;
    const ex = p[eye * 3];
    const ey = p[eye * 3 + 1];
    const ez = p[eye * 3 + 2];
    stamp++;
    const visible: number[] = [fi];
    start.stamp = stamp;
    const horizon: { a: number; b: number; across: number }[] = [];
    // iterative depth-first traversal reproducing the recursive horizon order
    const stack: { f: number; k: number; cnt: number }[] = [{ f: fi, k: 0, cnt: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.cnt === 3) {
        stack.pop();
        continue;
      }
      const e = (top.k + top.cnt) % 3;
      top.cnt++;
      const g = faces[top.f];
      const ni = g.nb[e];
      const nf = faces[ni];
      if (nf.stamp === stamp) continue;
      if (nf.nx * ex + nf.ny * ey + nf.nz * ez - nf.d > eps) {
        nf.stamp = stamp;
        visible.push(ni);
        const a = g.v[(e + 1) % 3];
        const b = g.v[e];
        let j = 0;
        while (j < 3 && !(nf.v[j] === a && nf.v[(j + 1) % 3] === b)) j++;
        stack.push({ f: ni, k: (j + 1) % 3, cnt: 0 });
      } else horizon.push({ a: g.v[e], b: g.v[(e + 1) % 3], across: ni });
    }
    if (horizon.length < 3) {
      // numerically inconsistent configuration: drop the eye point and continue
      start.outside = start.outside.filter((i) => i !== eye);
      start.far = -1;
      start.farDist = 0;
      for (const i of start.outside) {
        const d = dist(start, i);
        if (d > start.farDist) {
          start.farDist = d;
          start.far = i;
        }
      }
      if (start.outside.length) queue.push(fi);
      continue;
    }
    const created: number[] = [];
    for (const h of horizon) {
      const f = makeFace(h.a, h.b, eye);
      const idx = faces.length;
      faces.push(f);
      created.push(idx);
      f.nb[0] = h.across;
      const across = faces[h.across];
      for (let j = 0; j < 3; j++)
        if (across.v[j] === h.b && across.v[(j + 1) % 3] === h.a) {
          across.nb[j] = idx;
          break;
        }
    }
    const m = created.length;
    for (let k = 0; k < m; k++) {
      const f = faces[created[k]];
      f.nb[1] = created[(k + 1) % m];
      f.nb[2] = created[(k - 1 + m) % m];
    }
    for (const vi of visible) {
      const f = faces[vi];
      f.alive = false;
      for (const i of f.outside) if (i !== eye) assign(i, created);
      f.outside = [];
    }
    for (const c of created) if (faces[c].outside.length) queue.push(c);
  }

  const tris = faces.filter((f) => f.alive);
  return mergeCoplanar(p, tris, eps);
}

/** Directed edge a → b of a hull over n points as a number (exact in doubles). */
const edgeKey = (a: number, b: number, n: number) => a * n + b;

function linkNeighbours(faces: HullFace[], n: number): void {
  const edges = new Map<number, number>();
  faces.forEach((f, fi) => {
    for (let e = 0; e < 3; e++) edges.set(edgeKey(f.v[e], f.v[(e + 1) % 3], n), fi);
  });
  faces.forEach((f) => {
    for (let e = 0; e < 3; e++) {
      const twin = edges.get(edgeKey(f.v[(e + 1) % 3], f.v[e], n));
      if (twin !== undefined) f.nb[e] = twin;
    }
  });
}

/** Merges adjacent coplanar triangles into polygons and compacts the vertex list. */
function mergeCoplanar(p: number[], tris: HullFace[], eps: number): ConvexHull {
  const m = tris.length;
  const np = p.length / 3;
  const parent = tris.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const edgeOwner = new Map<number, number>();
  tris.forEach((t, ti) => {
    for (let e = 0; e < 3; e++) edgeOwner.set(edgeKey(t.v[e], t.v[(e + 1) % 3], np), ti);
  });
  for (let ti = 0; ti < m; ti++) {
    const t = tris[ti];
    for (let e = 0; e < 3; e++) {
      const o = edgeOwner.get(edgeKey(t.v[(e + 1) % 3], t.v[e], np));
      if (o === undefined || o <= ti) continue;
      const u = tris[o];
      if (t.nx * u.nx + t.ny * u.ny + t.nz * u.nz > 1 - 1e-9) {
        const a = find(ti);
        const b = find(o);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let ti = 0; ti < m; ti++) {
    const r = find(ti);
    const g = groups.get(r);
    if (g) g.push(ti);
    else groups.set(r, [ti]);
  }
  const polys: number[][] = [];
  for (const members of groups.values()) {
    const poly = members.length > 1 ? boundaryLoop(p, tris, members, eps) : null;
    if (poly) polys.push(poly);
    else for (const ti of members) polys.push([...tris[ti].v]);
  }
  // compact vertices
  const remap = new Map<number, number>();
  const points: number[] = [];
  const faces = polys.map((poly) =>
    poly.map((v) => {
      let r = remap.get(v);
      if (r === undefined) {
        r = points.length / 3;
        remap.set(v, r);
        points.push(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
      }
      return r;
    }),
  );
  const normals: Vec3[] = [];
  const offsets: number[] = [];
  for (const f of faces) {
    const nrm = newellNormal(points, f);
    normals.push(nrm);
    let d = 0;
    for (const v of f) d += nrm[0] * points[v * 3] + nrm[1] * points[v * 3 + 1] + nrm[2] * points[v * 3 + 2];
    offsets.push(d / f.length);
  }
  return { points, faces, normals, offsets, dimension: 3 };
}

/** Boundary loop of a group of coplanar triangles, or null when it is not a simple planar polygon. */
function boundaryLoop(p: number[], tris: HullFace[], members: number[], eps: number): number[] | null {
  const np = p.length / 3;
  const inGroup = new Set<number>();
  for (const ti of members) {
    const t = tris[ti];
    for (let e = 0; e < 3; e++) inGroup.add(edgeKey(t.v[e], t.v[(e + 1) % 3], np));
  }
  const next = new Map<number, number>();
  for (const ti of members) {
    const t = tris[ti];
    for (let e = 0; e < 3; e++) {
      const a = t.v[e];
      const b = t.v[(e + 1) % 3];
      if (inGroup.has(edgeKey(b, a, np))) continue;
      if (next.has(a)) return null;
      next.set(a, b);
    }
  }
  if (next.size < 3) return null;
  const startV = Math.min(...next.keys());
  const loop: number[] = [startV];
  let cur = next.get(startV)!;
  while (cur !== startV) {
    if (loop.length > next.size) return null;
    loop.push(cur);
    const nx = next.get(cur);
    if (nx === undefined) return null;
    cur = nx;
  }
  if (loop.length !== next.size) return null;
  // all loop vertices must lie on the group's plane
  const nrm = newellNormal(p, loop);
  let d = 0;
  for (const v of loop) d += nrm[0] * p[v * 3] + nrm[1] * p[v * 3 + 1] + nrm[2] * p[v * 3 + 2];
  d /= loop.length;
  for (const v of loop)
    if (Math.abs(nrm[0] * p[v * 3] + nrm[1] * p[v * 3 + 1] + nrm[2] * p[v * 3 + 2] - d) > 10 * eps)
      return null;
  return loop;
}

/** Hull of coplanar points: one polygon, as two opposite faces. */
function planarHull(p: number[], normal: Vec3, origin: Vec3, dir: Vec3, eps: number): ConvexHull {
  const u = normalize(dir);
  const v = cross(normal, u);
  const n = p.length / 3;
  const pts2: { x: number; y: number; i: number }[] = [];
  for (let i = 0; i < n; i++) {
    const d: Vec3 = [p[i * 3] - origin[0], p[i * 3 + 1] - origin[1], p[i * 3 + 2] - origin[2]];
    pts2.push({ x: dot(d, u), y: dot(d, v), i });
  }
  pts2.sort((a, b) => a.x - b.x || a.y - b.y || a.i - b.i);
  const crossZ = (o: (typeof pts2)[0], a: (typeof pts2)[0], b: (typeof pts2)[0]) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const tol = eps * eps;
  const lower: typeof pts2 = [];
  for (const q of pts2) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], q) <= tol)
      lower.pop();
    lower.push(q);
  }
  const upper: typeof pts2 = [];
  for (let k = pts2.length - 1; k >= 0; k--) {
    const q = pts2[k];
    while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], q) <= tol)
      upper.pop();
    upper.push(q);
  }
  const ring = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  if (ring.length < 3) {
    const a = pts2[0].i;
    const b = pts2[pts2.length - 1].i;
    return {
      points: [p[a * 3], p[a * 3 + 1], p[a * 3 + 2], p[b * 3], p[b * 3 + 1], p[b * 3 + 2]],
      faces: [],
      normals: [],
      offsets: [],
      dimension: 1,
    };
  }
  const points: number[] = [];
  for (const q of ring) points.push(p[q.i * 3], p[q.i * 3 + 1], p[q.i * 3 + 2]);
  const front = ring.map((_, k) => k);
  const back = [...front].reverse();
  const d = dot(normal, [points[0], points[1], points[2]]);
  return {
    points,
    faces: [front, back],
    normals: [[...normal], [-normal[0], -normal[1], -normal[2]]],
    offsets: [d, -d],
    dimension: 2,
  };
}

/** Unit polygon normal (Newell's method) for a loop indexing flat xyz `p`. */
export function newellNormal(p: ArrayLike<number>, loop: readonly number[]): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let k = 0; k < loop.length; k++) {
    const a = loop[k] * 3;
    const b = loop[(k + 1) % loop.length] * 3;
    nx += (p[a + 1] - p[b + 1]) * (p[a + 2] + p[b + 2]);
    ny += (p[a + 2] - p[b + 2]) * (p[a] + p[b]);
    nz += (p[a] - p[b]) * (p[a + 1] + p[b + 1]);
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
