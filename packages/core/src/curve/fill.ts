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
 * [outer, ...holes] as counter-clockwise triangles, i.e. with normals towards +Z.
 */
export function triangulatePolygon(
  outer: readonly Vec2[],
  holes: readonly (readonly Vec2[])[] = [],
): number[] {
  const coords: number[] = [];
  const holeIndices: number[] = [];
  for (const p of outer) coords.push(p[0], p[1]);
  for (const h of holes) {
    holeIndices.push(coords.length / 2);
    for (const p of h) coords.push(p[0], p[1]);
  }
  const tris = earcut(coords, holeIndices.length ? holeIndices : undefined, 2);
  const out: number[] = [];
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const a = tris[t];
    const b = tris[t + 1];
    const c = tris[t + 2];
    const cross =
      (coords[b * 2] - coords[a * 2]) * (coords[c * 2 + 1] - coords[a * 2 + 1]) -
      (coords[b * 2 + 1] - coords[a * 2 + 1]) * (coords[c * 2] - coords[a * 2]);
    if (cross === 0) continue;
    if (cross > 0) out.push(a, b, c);
    else out.push(a, c, b);
  }
  return out;
}
