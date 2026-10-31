import type { Vec2 } from '../math/types';

/*
 * Planar polygon booleans (union / intersection / difference of simple polygons, nested freely),
 * used to construct the built-in font's glyph outlines from strokes, rings and arcs.
 *
 * Method: every edge of every polygon is split where it meets edges of the other polygons; each
 * piece is kept when the shape's inside test differs on its two sides, oriented so the inside lies
 * on its left; the kept pieces are then chained into loops (outer boundaries counter-clockwise,
 * holes clockwise). Coordinates are snapped to a fine grid so that coincident or collinear edges of
 * different polygons are recognised exactly.
 */

export type Shape =
  { op: 'poly'; points: Vec2[] } | { op: 'union' | 'intersect' | 'difference'; items: Shape[] };

export const polygon = (points: Vec2[]): Shape => ({ op: 'poly', points });
export const union = (...items: Shape[]): Shape => ({ op: 'union', items });
export const intersect = (...items: Shape[]): Shape => ({ op: 'intersect', items });
/** `a` minus every other shape. */
export const difference = (a: Shape, ...rest: Shape[]): Shape => ({ op: 'difference', items: [a, ...rest] });

/** Applies a point mapping to every polygon of a shape (e.g. translation, scaling, mirroring). */
export function mapShape(s: Shape, fn: (p: Vec2) => Vec2): Shape {
  if (s.op === 'poly') return { op: 'poly', points: s.points.map(fn) };
  return { op: s.op, items: s.items.map((i) => mapShape(i, fn)) };
}

interface Leaf {
  points: Vec2[];
  /** Counter-clockwise polygon: its interior lies left of its edges. */
  ccw: boolean;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function leafInside(l: Leaf, x: number, y: number): boolean {
  if (x < l.x0 || x > l.x1 || y < l.y0 || y > l.y1) return false;
  const p = l.points;
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const yi = p[i][1];
    const yj = p[j][1];
    if (yi > y !== yj > y && x < ((p[j][0] - p[i][0]) * (y - yi)) / (yj - yi) + p[i][0]) inside = !inside;
  }
  return inside;
}

/**
 * Point membership of a shape (even-odd per polygon, then the boolean tree). Polygons listed in
 * `forced` use the given membership instead (the point lies on their boundary).
 */
function insideShape(
  s: Shape,
  leaves: Map<Shape, Leaf>,
  x: number,
  y: number,
  forced: Map<Leaf, boolean>,
): boolean {
  switch (s.op) {
    case 'poly': {
      const l = leaves.get(s);
      if (!l) return false;
      const f = forced.get(l);
      return f ?? leafInside(l, x, y);
    }
    case 'union':
      return s.items.some((i) => insideShape(i, leaves, x, y, forced));
    case 'intersect':
      return s.items.length > 0 && s.items.every((i) => insideShape(i, leaves, x, y, forced));
    case 'difference':
      return (
        s.items.length > 0 &&
        insideShape(s.items[0], leaves, x, y, forced) &&
        !s.items.slice(1).some((i) => insideShape(i, leaves, x, y, forced))
      );
  }
}

interface Edge {
  a: number;
  b: number;
  leaf: number;
  splits: { t: number; id: number }[];
}

/**
 * Outline loops of a shape. Each loop has the shape's inside on its left: outer boundaries are
 * counter-clockwise, holes clockwise. `grid` is the snapping resolution (shape units).
 */
export function shapeContours(shape: Shape, grid = 1e-3): Vec2[][] {
  const q = (v: number) => Math.round(v / grid) * grid;
  // --- polygons (snapped, without repeated points)
  const leafOf = new Map<Shape, Leaf>();
  const leaves: Leaf[] = [];
  const collect = (s: Shape) => {
    if (s.op !== 'poly') {
      s.items.forEach(collect);
      return;
    }
    const pts: Vec2[] = [];
    for (const p of s.points) {
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      const v: Vec2 = [q(p[0]), q(p[1])];
      const last = pts[pts.length - 1];
      if (!last || last[0] !== v[0] || last[1] !== v[1]) pts.push(v);
    }
    while (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1])
      pts.pop();
    if (pts.length < 3) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    }
    const l: Leaf = { points: pts, ccw: loopArea(pts) > 0, x0, y0, x1, y1 };
    leafOf.set(s, l);
    leaves.push(l);
  };
  collect(shape);
  if (leaves.length === 0) return [];

  // --- shared point registry (snapped coordinates → id)
  const P: Vec2[] = [];
  const ids = new Map<string, number>();
  const pid = (x: number, y: number): number => {
    const qx = q(x);
    const qy = q(y);
    const key = `${qx},${qy}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = P.length;
      P.push([qx, qy]);
      ids.set(key, id);
    }
    return id;
  };
  const edges: Edge[] = [];
  leaves.forEach((l, li) => {
    const n = l.points.length;
    for (let i = 0; i < n; i++) {
      const a = l.points[i];
      const b = l.points[(i + 1) % n];
      edges.push({ a: pid(a[0], a[1]), b: pid(b[0], b[1]), leaf: li, splits: [] });
    }
  });

  // --- split edges at intersections with other polygons' edges
  const tol = grid * 0.5;
  for (let i = 0; i < edges.length; i++) {
    const e1 = edges[i];
    const p = P[e1.a];
    const p2 = P[e1.b];
    const rx = p2[0] - p[0];
    const ry = p2[1] - p[1];
    const rl = Math.hypot(rx, ry);
    if (rl === 0) continue;
    const bx0 = Math.min(p[0], p2[0]) - tol;
    const bx1 = Math.max(p[0], p2[0]) + tol;
    const by0 = Math.min(p[1], p2[1]) - tol;
    const by1 = Math.max(p[1], p2[1]) + tol;
    for (let j = i + 1; j < edges.length; j++) {
      const e2 = edges[j];
      if (e2.leaf === e1.leaf) continue;
      const qa = P[e2.a];
      const qb = P[e2.b];
      if (Math.max(qa[0], qb[0]) < bx0 || Math.min(qa[0], qb[0]) > bx1) continue;
      if (Math.max(qa[1], qb[1]) < by0 || Math.min(qa[1], qb[1]) > by1) continue;
      const sx = qb[0] - qa[0];
      const sy = qb[1] - qa[1];
      const sl = Math.hypot(sx, sy);
      if (sl === 0) continue;
      const qpx = qa[0] - p[0];
      const qpy = qa[1] - p[1];
      const rxs = rx * sy - ry * sx;
      const qpxr = qpx * ry - qpy * rx;
      if (Math.abs(rxs) <= 1e-12 * rl * sl) {
        // parallel: only collinear overlaps matter (split each at the other's end points)
        if (Math.abs(qpxr) / rl > tol) continue;
        const along1 = (pt: Vec2) => ((pt[0] - p[0]) * rx + (pt[1] - p[1]) * ry) / (rl * rl);
        const along2 = (pt: Vec2) => ((pt[0] - qa[0]) * sx + (pt[1] - qa[1]) * sy) / (sl * sl);
        const t1 = tol / rl;
        const t2 = tol / sl;
        for (const id of [e2.a, e2.b]) {
          const t = along1(P[id]);
          if (t > t1 && t < 1 - t1) e1.splits.push({ t, id });
        }
        for (const id of [e1.a, e1.b]) {
          const t = along2(P[id]);
          if (t > t2 && t < 1 - t2) e2.splits.push({ t, id });
        }
        continue;
      }
      const t = (qpx * sy - qpy * sx) / rxs;
      const u = qpxr / rxs;
      const et = tol / rl;
      const eu = tol / sl;
      if (t < -et || t > 1 + et || u < -eu || u > 1 + eu) continue;
      let id: number;
      if (t <= et) id = e1.a;
      else if (t >= 1 - et) id = e1.b;
      else if (u <= eu) id = e2.a;
      else if (u >= 1 - eu) id = e2.b;
      else id = pid(p[0] + rx * t, p[1] + ry * t);
      if (t > et && t < 1 - et) e1.splits.push({ t, id });
      if (u > eu && u < 1 - eu) e2.splits.push({ t: u, id });
    }
  }

  // --- classify the pieces exactly: a piece is kept when the shape's membership differs on its two
  // sides. Its midpoint is tested against every other polygon; the polygons the piece lies on
  // (coincident pieces are grouped) are forced inside on their interior side and outside on the other.
  const groups = new Map<string, { a: number; b: number; leaves: { leaf: Leaf; sameDir: boolean }[] }>();
  for (const e of edges) {
    e.splits.sort((a, b) => a.t - b.t);
    const chain = [e.a];
    for (const s of e.splits) if (chain[chain.length - 1] !== s.id) chain.push(s.id);
    if (chain[chain.length - 1] !== e.b) chain.push(e.b);
    for (let k = 0; k + 1 < chain.length; k++) {
      const x = chain[k];
      const y = chain[k + 1];
      if (x === y) continue;
      const a = Math.min(x, y);
      const b = Math.max(x, y);
      const key = `${a},${b}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { a, b, leaves: [] }));
      g.leaves.push({ leaf: leaves[e.leaf], sameDir: x === a });
    }
  }
  const kept: [number, number][] = [];
  for (const g of groups.values()) {
    const A = P[g.a];
    const B = P[g.b];
    const mx = (A[0] + B[0]) / 2;
    const my = (A[1] + B[1]) / 2;
    const left = new Map<Leaf, boolean>();
    const right = new Map<Leaf, boolean>();
    for (const { leaf, sameDir } of g.leaves) {
      // a counter-clockwise polygon has its interior on the left of its own edge direction
      const interiorLeft = leaf.ccw === sameDir;
      left.set(leaf, interiorLeft);
      right.set(leaf, !interiorLeft);
    }
    const inL = insideShape(shape, leafOf, mx, my, left);
    const inR = insideShape(shape, leafOf, mx, my, right);
    if (inL !== inR) kept.push(inL ? [g.a, g.b] : [g.b, g.a]);
  }

  // --- chain into loops (at shared vertices take the leftmost turn: touching loops stay apart)
  const outgoing = new Map<number, [number, number][]>();
  const list: [number, number][] = kept;
  for (const ed of list) {
    const o = outgoing.get(ed[0]);
    if (o) o.push(ed);
    else outgoing.set(ed[0], [ed]);
  }
  const used = new Set<[number, number]>();
  const loops: Vec2[][] = [];
  for (const start of list) {
    if (used.has(start)) continue;
    used.add(start);
    const loop: number[] = [start[0]];
    let cur = start;
    let ok = false;
    for (let guard = 0; guard <= list.length; guard++) {
      const at = cur[1];
      if (at === loop[0]) {
        ok = true;
        break;
      }
      const cands = (outgoing.get(at) ?? []).filter((c) => !used.has(c));
      if (cands.length === 0) {
        // stuck next to the start (two snapped copies of one point): close the loop there
        ok = Math.hypot(P[at][0] - P[loop[0]][0], P[at][1] - P[loop[0]][1]) <= grid * 4;
        break;
      }
      let best = cands[0];
      if (cands.length > 1) {
        const ix = P[at][0] - P[cur[0]][0];
        const iy = P[at][1] - P[cur[0]][1];
        let bestAngle = -Infinity;
        for (const c of cands) {
          if (c[1] === cur[0]) continue; // never turn straight back unless forced
          const ox = P[c[1]][0] - P[at][0];
          const oy = P[c[1]][1] - P[at][1];
          const ang = Math.atan2(ix * oy - iy * ox, ix * ox + iy * oy);
          if (ang > bestAngle) {
            bestAngle = ang;
            best = c;
          }
        }
      }
      used.add(best);
      loop.push(at);
      cur = best;
    }
    if (!ok) continue;
    const pts = simplifyLoop(loop.map((i) => P[i]));
    if (pts.length >= 3 && Math.abs(loopArea(pts)) > grid * grid) loops.push(pts);
  }
  return loops;
}

function loopArea(p: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
}

/** Removes vertices in the middle of straight runs. */
function simplifyLoop(pts: Vec2[]): Vec2[] {
  let cur = pts;
  for (let pass = 0; pass < 3; pass++) {
    const n = cur.length;
    if (n < 3) return cur;
    const out: Vec2[] = [];
    for (let i = 0; i < n; i++) {
      const a = cur[(i - 1 + n) % n];
      const b = cur[i];
      const c = cur[(i + 1) % n];
      const d1x = b[0] - a[0];
      const d1y = b[1] - a[1];
      const d2x = c[0] - b[0];
      const d2y = c[1] - b[1];
      const cr = d1x * d2y - d1y * d2x;
      const dt = d1x * d2x + d1y * d2y;
      const l = Math.hypot(d1x, d1y) * Math.hypot(d2x, d2y);
      if (l === 0) continue;
      if (Math.abs(cr) <= 1e-9 * l && dt > 0) continue;
      out.push(b);
    }
    if (out.length === n) return out;
    cur = out;
  }
  return cur;
}
