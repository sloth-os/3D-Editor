import earcut from 'earcut';
import type { Vec2 } from '../math/types';

/*
 * Planar polygon helpers for filling 2D curves and text: signed areas, point-in-polygon, even-odd
 * nesting (contours inside contours become holes) and triangulation of a contour with its holes.
 */

/** Signed area of a closed polygon (counter-clockwise positive). */
export function signedArea(poly: readonly (readonly number[])[]): number {
  let a = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Even-odd point in polygon test. */
export function pointInPolygon(x: number, y: number, poly: readonly (readonly number[])[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface FillRegion {
  /** Index of the outer contour. */
  outer: number;
  /** Indices of the contours forming its holes. */
  holes: number[];
}

export interface Nesting {
  regions: FillRegion[];
  /** Number of contours enclosing each contour (-1 for degenerate contours that are ignored). */
  depth: number[];
}

/**
 * Even-odd nesting of closed contours: contours enclosed by an even number of others are outer
 * boundaries, odd ones are holes of their innermost enclosing contour. Degenerate (zero-area)
 * contours are ignored.
 */
export function nestContours(contours: readonly (readonly Vec2[])[]): Nesting {
  const n = contours.length;
  const area = contours.map((c) => Math.abs(signedArea(c)));
  const box = contours.map((c) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of c) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    return [x0, y0, x1, y1];
  });
  const valid = contours.map((c, i) => c.length >= 3 && area[i] > 1e-14);
  const parents: number[][] = contours.map(() => []);
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    const bi = box[i];
    for (let j = 0; j < n; j++) {
      if (i === j || !valid[j] || area[j] <= area[i]) continue;
      const bj = box[j];
      if (bi[0] < bj[0] || bi[1] < bj[1] || bi[2] > bj[2] || bi[3] > bj[3]) continue;
      if (contains(contours[j], contours[i])) parents[i].push(j);
    }
  }
  const depth = contours.map((_, i) => (valid[i] ? parents[i].length : -1));
  const regions: FillRegion[] = [];
  const regionOf = new Map<number, FillRegion>();
  for (let i = 0; i < n; i++) {
    if (!valid[i] || depth[i] % 2 !== 0) continue;
    const r: FillRegion = { outer: i, holes: [] };
    regions.push(r);
    regionOf.set(i, r);
  }
  for (let i = 0; i < n; i++) {
    if (!valid[i] || depth[i] % 2 !== 1) continue;
    // the innermost enclosing contour (deepest parent)
    let best = -1;
    for (const p of parents[i]) if (best < 0 || depth[p] > depth[best]) best = p;
    regionOf.get(best)?.holes.push(i);
  }
  return { regions, depth };
}

/** Whether polygon `outer` contains polygon `inner` (tested on vertices not lying on the boundary). */
function contains(outer: readonly Vec2[], inner: readonly Vec2[]): boolean {
  let votes = 0;
  const step = Math.max(1, Math.floor(inner.length / 7));
  let tested = 0;
  for (let k = 0; k < inner.length && tested < 7; k += step) {
    const p = inner[k];
    if (onBoundary(p, outer)) continue;
    tested++;
    votes += pointInPolygon(p[0], p[1], outer) ? 1 : -1;
  }
  if (tested === 0) {
    // every tested vertex touches the boundary: decide with an edge midpoint
    const a = inner[0];
    const b = inner[1 % inner.length];
    return pointInPolygon((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, outer);
  }
  return votes > 0;
}

function onBoundary(p: Vec2, poly: readonly Vec2[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const ex = a[0] + dx * t - p[0];
    const ey = a[1] + dy * t - p[1];
    if (ex * ex + ey * ey < 1e-18) return true;
  }
  return false;
}

/**
 * Triangulates a polygon with holes (any orientation). Returns indices into the concatenation
 * [outer, ...holes] as counter-clockwise triangles, i.e. with normals towards +Z. Every boundary
 * edge of the polygon is an edge of exactly one triangle (no T-junctions), so the triangles can
 * close a solid together with walls built on the same boundary vertices.
 */
export function triangulatePolygon(
  outer: readonly Vec2[],
  holes: readonly (readonly Vec2[])[] = [],
): number[] {
  const coords: number[] = [];
  const holeIndices: number[] = [];
  const loops: [number, number][] = [];
  const add = (loop: readonly Vec2[]) => {
    loops.push([coords.length / 2, loop.length]);
    for (const p of loop) coords.push(p[0], p[1]);
  };
  add(outer);
  for (const h of holes) {
    holeIndices.push(coords.length / 2);
    add(h);
  }
  const tris = earcut(coords, holeIndices.length ? holeIndices : undefined, 2);
  const cross = (t: number) => {
    const a = tris[t] * 2;
    const b = tris[t + 1] * 2;
    const c = tris[t + 2] * 2;
    return (
      (coords[b] - coords[a]) * (coords[c + 1] - coords[a + 1]) -
      (coords[b + 1] - coords[a + 1]) * (coords[c] - coords[a])
    );
  };
  // earcut keeps the orientation of its rings: flip the whole set at once to face +Z (a triangle
  // inside a fold of a self-overlapping outline then faces backwards, keeping the cap consistent)
  let total = 0;
  for (let t = 0; t + 2 < tris.length; t += 3) total += cross(t);
  const out: number[] = [];
  for (let t = 0; t + 2 < tris.length; t += 3) {
    if (cross(t) === 0) continue; // degenerate: its edges are recovered by closeTJunctions
    if (total >= 0) out.push(tris[t], tris[t + 1], tris[t + 2]);
    else out.push(tris[t], tris[t + 2], tris[t + 1]);
  }
  return closeTJunctions(out, coords, loops);
}

/** Vertex count above which the general T-junction search is skipped (pathological input). */
const MAX_T_JUNCTION_SEARCH = 4000;

/**
 * Makes every boundary edge of the loops an edge of the triangulation. Earcut leaves out vertices
 * that are exactly collinear with their neighbours (straight runs of sampled splines, or a hole
 * bridged along a line shared with the outer boundary): the area stays covered, but a longer
 * triangle edge then spans several boundary edges (a T-junction), which would leave extruded solids
 * open. Such triangles are split into fans at the spanned boundary vertices.
 */
function closeTJunctions(
  flat: number[],
  coords: readonly number[],
  loops: readonly [number, number][],
): number[] {
  const n = coords.length / 2;
  const key = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  const tri: number[][] = [];
  for (let t = 0; t + 2 < flat.length; t += 3) tri.push([flat[t], flat[t + 1], flat[t + 2]]);
  const edgeTris = new Map<number, Set<number>>();
  const link = (t: number, on: boolean) => {
    const v = tri[t];
    for (let k = 0; k < 3; k++) {
      const id = key(v[k], v[(k + 1) % 3]);
      let set = edgeTris.get(id);
      if (on) {
        if (!set) edgeTris.set(id, (set = new Set()));
        set.add(t);
      } else if (set) {
        set.delete(t);
        if (set.size === 0) edgeTris.delete(id);
      }
    }
  };
  for (let t = 0; t < tri.length; t++) link(t, true);
  const boundary = new Set<number>();
  for (const [s, c] of loops)
    if (c >= 3) for (let i = 0; i < c; i++) boundary.add(key(s + i, s + ((i + 1) % c)));
  const missingEdges = (): [number, number][] => {
    const out: [number, number][] = [];
    for (const [s, c] of loops)
      if (c >= 3)
        for (let i = 0; i < c; i++) {
          const a = s + i;
          const b = s + ((i + 1) % c);
          if (!edgeTris.has(key(a, b))) out.push([a, b]);
        }
    return out;
  };
  let missing = missingEdges();
  if (missing.length === 0) {
    // every boundary edge is covered; inner edges with a single triangle mark a gap inside a fold
    for (const [id, set] of edgeTris)
      if (set.size === 1 && !boundary.has(id)) {
        patchGaps(tri, coords, loops);
        return tri.flat();
      }
    return flat;
  }

  const x = (i: number) => coords[i * 2];
  const y = (i: number) => coords[i * 2 + 1];
  /** Position of `v` strictly inside segment p→q as a fraction of its length (NaN when off it). */
  const along = (p: number, q: number, v: number): number => {
    const dx = x(q) - x(p);
    const dy = y(q) - y(p);
    const l2 = dx * dx + dy * dy;
    if (!(l2 > 0) || v === p || v === q) return NaN;
    const vx = x(v) - x(p);
    const vy = y(v) - y(p);
    if (Math.abs(vx * dy - vy * dx) > 1e-9 * l2) return NaN;
    const t = (vx * dx + vy * dy) / l2;
    return t > 1e-12 && t < 1 - 1e-12 ? t : NaN;
  };
  /** Splits the triangles on edge p–q at `inner` (vertices on the edge, ordered from p to q). */
  const split = (p: number, q: number, inner: number[]): boolean => {
    const set = edgeTris.get(key(p, q));
    if (!set || inner.length === 0) return false;
    for (const t of [...set]) {
      const v = tri[t];
      // rotate the triangle to (u, w, o) where {u, w} = {p, q}; keep its counter-clockwise order
      const k = v.findIndex((a, i) => (a === p || a === q) && (v[(i + 1) % 3] === p || v[(i + 1) % 3] === q));
      const u = v[k];
      const o = v[(k + 2) % 3];
      const chain = u === p ? [p, ...inner, q] : [q, ...inner.slice().reverse(), p];
      link(t, false);
      tri[t] = [chain[0], chain[1], o];
      link(t, true);
      for (let i = 1; i + 1 < chain.length; i++) {
        tri.push([chain[i], chain[i + 1], o]);
        link(tri.length - 1, true);
      }
    }
    return true;
  };

  for (let pass = 0; pass < 3 && missing.length > 0; pass++) {
    let progress = false;
    // 1. runs of collinear missing edges along a loop, spanned by one triangle edge
    const isMissing = new Set(missing.map(([a, b]) => key(a, b)));
    for (const [s, c] of loops) {
      if (c < 3) continue;
      const next = (i: number) => s + ((i - s + 1) % c);
      for (let i = s; i < s + c; i++) {
        if (!isMissing.has(key(i, next(i)))) continue;
        const chain = [i, next(i)];
        while (chain.length <= c) {
          const last = chain[chain.length - 1];
          const nx = next(last);
          if (!isMissing.has(key(last, nx)) || Number.isNaN(along(chain[0], nx, last))) break;
          chain.push(nx);
        }
        if (chain.length > 2 && split(chain[0], chain[chain.length - 1], chain.slice(1, -1))) {
          for (let k = 0; k + 1 < chain.length; k++) isMissing.delete(key(chain[k], chain[k + 1]));
          progress = true;
        }
      }
    }
    missing = missingEdges();
    // 2. general case (e.g. a bridge to a hole along a shared line): triangle edges between end points
    //    of missing edges that pass through other such end points
    const ends = [...new Set(missing.flat())];
    if (missing.length > 0 && ends.length <= MAX_T_JUNCTION_SEARCH) {
      const isEnd = new Set(ends);
      const spans: [number, number][] = [];
      for (const id of edgeTris.keys()) {
        const p = Math.floor(id / n);
        const q = id - p * n;
        if (isEnd.has(p) && isEnd.has(q)) spans.push([p, q]);
      }
      for (const [p, q] of spans) {
        const inner = ends
          .map((v) => [v, along(p, q, v)] as const)
          .filter(([, t]) => !Number.isNaN(t))
          .sort((a, b) => a[1] - b[1])
          .map(([v]) => v);
        if (inner.length && split(p, q, inner)) progress = true;
      }
      missing = missingEdges();
    }
    if (!progress) break;
  }
  if (missing.length > 0) patchGaps(tri, coords, loops);
  return tri.flat();
}

/**
 * Last resort for self-intersecting outlines (e.g. the folds of strongly offset text), where earcut
 * skips slivers of the area: closes the remaining gaps of the triangulation with triangle fans so that
 * every boundary edge is covered once and every inner edge twice (the cap stays watertight; a patch
 * inside a fold may face backwards, like the folded walls around it).
 */
function patchGaps(tri: number[][], coords: readonly number[], loops: readonly [number, number][]): void {
  const n = coords.length / 2;
  const half = new Map<number, number>(); // directed edge a→b (a·n + b) → uses
  for (const v of tri)
    for (let k = 0; k < 3; k++) {
      const id = v[k] * n + v[(k + 1) % 3];
      half.set(id, (half.get(id) ?? 0) + 1);
    }
  const boundary = new Set<number>();
  const need: [number, number][] = [];
  loops.forEach(([s, c], li) => {
    if (c < 3) return;
    let area = 0;
    for (let i = 0; i < c; i++) {
      const a = s + i;
      const b = s + ((i + 1) % c);
      area += coords[a * 2] * coords[b * 2 + 1] - coords[b * 2] * coords[a * 2 + 1];
    }
    // direction with the filled area on its left (counter-clockwise outer, clockwise holes)
    const forward = li === 0 ? area > 0 : area < 0;
    for (let i = 0; i < c; i++) {
      const a = s + i;
      const b = s + ((i + 1) % c);
      const [u, v] = forward ? [a, b] : [b, a];
      boundary.add(Math.min(u, v) * n + Math.max(u, v));
      if (!half.has(u * n + v) && !half.has(v * n + u)) need.push([u, v]);
    }
  });
  for (const [id, uses] of half) {
    const u = Math.floor(id / n);
    const v = id - u * n;
    if (uses === 1 && !boundary.has(Math.min(u, v) * n + Math.max(u, v)) && !half.has(v * n + u))
      need.push([v, u]);
  }
  const from = new Map<number, number[]>();
  for (const [u, v] of need) {
    const list = from.get(u);
    if (list) list.push(v);
    else from.set(u, [v]);
  }
  for (const [start] of need) {
    const cycle = [start];
    let cur = start;
    for (let guard = 0; guard <= need.length; guard++) {
      const next = from.get(cur)?.pop();
      if (next === undefined || next === start) {
        if (next === start && cycle.length >= 3)
          for (let i = 1; i + 1 < cycle.length; i++) tri.push([cycle[0], cycle[i], cycle[i + 1]]);
        break;
      }
      cycle.push(next);
      cur = next;
    }
  }
}
