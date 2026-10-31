import type { Vec3 } from '../../math/types';
import type { MeshData } from '../types';
import { cloneMesh, edgeKey, pruneEdgeData } from '../types';
import type { MeshSelection } from '../selection';
import { selectionFromFaces } from '../selection';
import { buildTopology } from '../topology';
import { faceNormal } from '../normals';
import type { MeshOpResult } from './types';
import {
  addVertexFrom,
  allFaceRecs,
  completeSelection,
  directedEdgeFaces,
  dkey,
  type FaceRec,
  pushTo,
  removeUnusedAmong,
  requireNonEmpty,
  setVpos,
  type UVFrame,
  uvFrame,
  uvOf,
  type VertexFan,
  vertexFan,
  vpos,
  writeFaces,
} from './util';

/*
 * Bevel (Ctrl+B / Ctrl+Shift+B).
 *
 * Algorithm (original, simplified compared to Blender's bmesh bevel):
 * - Every beveled vertex is processed using its ordered face fan. Each face corner at the vertex
 *   is replaced by new "rail" vertices: a miter point inside the face when both adjacent edges are
 *   beveled, or a point sliding along the unbeveled edge when only one is. Corners between two
 *   unbeveled edges keep the original vertex (with slide points inserted next to it so no
 *   T-junctions appear).
 * - Every beveled edge becomes a strip of `segments` quads between the rails at its two ends,
 *   following a superellipse profile (profile 0.5 = circular arc, 0.25 = straight chamfer).
 * - The hole left at each vertex is found from the unpaired edges of the new faces and closed with
 *   a corner patch: a polygon, a rounded triangle grid (3-edge corners with segments > 1, projected
 *   onto a sphere when the profiles allow it) or a fan. A patch that only touches one other face
 *   (terminal edge at a 3-valent vertex) is merged into that face like Blender does.
 *
 * Limitations: only manifold edges (exactly two consistently wound faces) at manifold vertices
 * are beveled; overlapping bevels are not clamped unless `clampOverlap` is set; there are no
 * miter/harden-normal/spread/custom-profile options; corner patches of vertices with more than three
 * beveled edges and segments > 1 are filled with a triangle fan rather than a quad grid.
 */

export type BevelOffsetType = 'OFFSET' | 'WIDTH' | 'DEPTH';

export interface BevelOptions {
  /** Bevel amount (object local units), interpreted according to `offsetType`. */
  offset: number;
  /** OFFSET: distance of the new edges from the original edge along the faces; WIDTH: width of the
   *  bevel face; DEPTH: perpendicular distance from the original edge to the bevel face. */
  offsetType?: BevelOffsetType;
  /** Number of segments across the bevel (default 1). */
  segments?: number;
  /** Profile shape 0..1: 0.5 round (default), 0.25 straight, 1 square, below 0.25 concave. */
  profile?: number;
  /** Bevel the selected EDGES (default) or only the selected VERTICES. */
  affect?: 'EDGES' | 'VERTICES';
  /** Limit the offset so new vertices never pass the middle of the edges they slide along. */
  clampOverlap?: boolean;
}

type V3 = Vec3;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-14 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/** Superellipse exponent for a profile value (0.5 → 2 = circle, 0.25 → 1 = line, 1 → ∞ = square). */
export function profileExponent(profile: number): number {
  const p = Math.min(0.999, Math.max(0.001, profile));
  return (-2 * Math.LN2) / Math.log(p);
}

/**
 * Points of a profile from A to B bulging towards the corner V (endpoints excluded): the
 * superellipse x^r + y^r = 1 mapped to the frame (A − C, B − C) with C = A + B − V.
 */
export function profilePoints(A: V3, B: V3, V: V3, segments: number, r: number): V3[] {
  const C = sub(add(A, B), V);
  const ca = sub(A, C);
  const cb = sub(B, C);
  const out: V3[] = [];
  for (let k = 1; k < segments; k++) {
    const th = (Math.PI / 2) * (k / segments);
    const x = Math.pow(Math.cos(th), 2 / r);
    const y = Math.pow(Math.sin(th), 2 / r);
    out.push(add(C, add(mul(ca, x), mul(cb, y))));
  }
  return out;
}

interface Profile {
  /** Vertices from the X-side rail to the Y-side rail (rails included). */
  verts: number[];
  /** Center used for the rounded shape (for corner sphere fitting). */
  center: V3;
}

export function bevel(src: MeshData, sel: MeshSelection, opts: BevelOptions): MeshOpResult {
  const segs = Math.max(1, Math.min(1000, Math.floor(opts.segments ?? 1)));
  const r = profileExponent(opts.profile ?? 0.5);
  const offsetType = opts.offsetType ?? 'OFFSET';
  const vertexMode = opts.affect === 'VERTICES';
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  const dmap = directedEdgeFaces(src);
  const recs = allFaceRecs(src);
  const m = cloneMesh(src);
  const fans = new Map<number, VertexFan | null>();
  const fanOf = (v: number): VertexFan | null => {
    if (!fans.has(v)) fans.set(v, vertexFan(src, v, topo.vertFaces[v], dmap));
    return fans.get(v)!;
  };
  const traverses = (f: number, a: number, b: number) => {
    const face = src.faces[f];
    const i = face.indexOf(a);
    return i >= 0 && face[(i + 1) % face.length] === b;
  };

  // ---------------------------------------------------------------- what is beveled
  const beveled = new Set<number>();
  const affected: number[] = [];
  if (vertexMode) {
    for (const v of [...s.verts].sort((a, b) => a - b))
      if (fanOf(v) && topo.vertEdges[v].length >= 2) affected.push(v);
    requireNonEmpty(affected.length, 'manifold vertices');
  } else {
    for (const k of s.edges) {
      const e = topo.edgeIndex.get(k)!;
      const ef = topo.edgeFaces[e];
      const [a, b] = topo.edges[e];
      if (ef.length === 2 && traverses(ef[0], a, b) !== traverses(ef[1], a, b)) beveled.add(e);
    }
    for (let changed = true; changed;) {
      changed = false;
      for (const e of beveled)
        if (topo.edges[e].some((v) => !fanOf(v))) {
          beveled.delete(e);
          changed = true;
        }
    }
    requireNonEmpty(beveled.size, 'manifold edges');
    const set = new Set<number>();
    for (const e of beveled) for (const v of topo.edges[e]) set.add(v);
    affected.push(...[...set].sort((a, b) => a - b));
  }
  const affectedSet = new Set(affected);

  // Offset of a beveled edge measured along its faces.
  const edgeOffset = new Map<number, number>();
  const offsetOf = (e: number): number => {
    let d = edgeOffset.get(e);
    if (d !== undefined) return d;
    d = opts.offset;
    if (offsetType !== 'OFFSET' && topo.edgeFaces[e].length === 2) {
      const n1 = faceNormal(src, topo.edgeFaces[e][0]);
      const n2 = faceNormal(src, topo.edgeFaces[e][1]);
      const theta = Math.acos(Math.max(-1, Math.min(1, dot(n1, n2))));
      if (offsetType === 'WIDTH') d = opts.offset / (2 * Math.max(0.05, Math.cos(theta / 2)));
      else d = opts.offset / Math.max(0.05, Math.sin(theta / 2));
    }
    edgeOffset.set(e, d);
    return d;
  };

  // ---------------------------------------------------------------- corners
  /** Replacement list per (vertex, face) in face loop order. */
  const corners = new Map<string, number[]>();
  const ckey = (v: number, f: number) => `${v}:${f}`;
  const owner = new Map<number, number>(); // new vertex → beveled vertex it belongs to
  const rails = new Set<number>();
  const created: number[] = [];
  /** Endpoint replacement of unbeveled edges (for edge attribute transfer). */
  const slideOn = new Map<string, number>();
  const newVert = (p: V3, v: number): number => {
    const x = addVertexFrom(m, p, [v]);
    owner.set(x, v);
    created.push(x);
    return x;
  };

  for (const v of affected) {
    owner.set(v, v);
    const fan = fanOf(v)!;
    const k = fan.faces.length;
    const P = vpos(src, v);
    const w: number[] = [];
    for (let i = 0; i < k; i++) {
      const face = src.faces[fan.faces[i]];
      w.push(face[(fan.corners[i] + face.length - 1) % face.length]);
    }
    if (!fan.closed) {
      const face = src.faces[fan.faces[k - 1]];
      w.push(face[(fan.corners[k - 1] + 1) % face.length]);
    }
    const eIdx = w.map((x) => topo.edgeIndex.get(edgeKey(v, x))!);
    const dirs = w.map((x) => norm(sub(vpos(src, x), P)));
    const lens = w.map((x) => len(sub(vpos(src, x), P)));
    const outOf = (i: number) => (fan.closed ? (i + 1) % k : i + 1);
    const maxSlide = (j: number, t: number): number => {
      if (!opts.clampOverlap) return t;
      return Math.min(t, lens[j] * (affectedSet.has(w[j]) ? 0.5 : 0.98));
    };
    /** Distance along edge j that keeps the new vertex `d` away from the beveled edge's line. */
    const slideAlong = (j: number, d: number, sinA: number): number => {
      const t = maxSlide(j, d / Math.max(sinA, 0.05));
      return sinA < 0.25 ? Math.min(t, 0.98 * lens[j]) : t;
    };
    const lists: number[][] = [];
    if (vertexMode) {
      const d = opts.offset;
      const slide = w.map((_, j) => newVert(add(P, mul(dirs[j], maxSlide(j, d))), v));
      slide.forEach((x, j) => {
        rails.add(x);
        slideOn.set(`${v}:${eIdx[j]}`, x);
      });
      for (let i = 0; i < k; i++) {
        const a = slide[i];
        const b = slide[outOf(i)];
        const mid = profilePoints(vpos(m, a), vpos(m, b), P, segs, r).map((p) => newVert(p, v));
        lists.push([a, ...mid, b]);
      }
    } else {
      const bev = eIdx.map((e) => beveled.has(e));
      for (let i = 0; i < k; i++) {
        const a = i;
        const b = outOf(i);
        const sinA = len(cross(dirs[a], dirs[b]));
        if (bev[a] && bev[b]) {
          const dIn = offsetOf(eIdx[a]);
          const dOut = offsetOf(eIdx[b]);
          let p: V3;
          if (sinA > 0.05)
            p = add(P, add(mul(dirs[a], maxSlide(a, dOut / sinA)), mul(dirs[b], maxSlide(b, dIn / sinA))));
          else {
            // (Nearly) straight continuation: offset perpendicular into the face (left of v→next).
            const perp = norm(cross(faceNormal(src, fan.faces[i]), dirs[b]));
            p = add(P, mul(perp, (dIn + dOut) / 2));
          }
          const x = newVert(p, v);
          rails.add(x);
          lists.push([x]);
        } else if (bev[a]) {
          const x = newVert(add(P, mul(dirs[b], slideAlong(b, offsetOf(eIdx[a]), sinA))), v);
          rails.add(x);
          lists.push([x]);
        } else if (bev[b]) {
          const x = newVert(add(P, mul(dirs[a], slideAlong(a, offsetOf(eIdx[b]), sinA))), v);
          rails.add(x);
          lists.push([x]);
        } else lists.push([v]);
      }
      // Make both faces of every unbeveled edge agree on its endpoint at v.
      const nE = w.length;
      for (let j = 0; j < nE; j++) {
        if (bev[j]) continue;
        const prevFace = fan.closed ? (j + k - 1) % k : j - 1;
        const nextFace = j;
        if (prevFace < 0 || nextFace >= k) continue; // boundary edge: one face only
        const pl = lists[prevFace];
        const nl = lists[nextFace];
        const last = pl[pl.length - 1];
        const first = nl[0];
        if (last !== v && first !== v) {
          if (last !== first) {
            setVpos(m, last, mul(add(vpos(m, last), vpos(m, first)), 0.5));
            nl[0] = last;
          }
          slideOn.set(`${v}:${eIdx[j]}`, last);
        } else if (last !== v) {
          nl.unshift(last);
          slideOn.set(`${v}:${eIdx[j]}`, last);
        } else if (first !== v) {
          pl.push(first);
          slideOn.set(`${v}:${eIdx[j]}`, first);
        }
      }
      // Boundary (open fan) edges next to a beveled edge: the slide point is their new endpoint.
      if (!fan.closed) {
        if (lists[0][0] !== v) slideOn.set(`${v}:${eIdx[0]}`, lists[0][0]);
        const ll = lists[k - 1];
        if (ll[ll.length - 1] !== v) slideOn.set(`${v}:${eIdx[nE - 1]}`, ll[ll.length - 1]);
      }
    }
    for (let i = 0; i < k; i++) corners.set(ckey(v, fan.faces[i]), lists[i]);
  }

  // ---------------------------------------------------------------- modified original faces
  const frames = new Map<number, UVFrame | null>();
  const frameOf = (f: number) => {
    if (!frames.has(f)) frames.set(f, uvFrame(src, recs[f]));
    return frames.get(f)!;
  };
  const cornerUV = new Map<string, [number, number]>(); // `${face}:${vertex}` → uv
  const out: FaceRec[] = [];
  for (let f = 0; f < src.faces.length; f++) {
    const rec = recs[f];
    const face = src.faces[f];
    if (!face.some((v) => corners.has(ckey(v, f)))) {
      out.push(rec);
      continue;
    }
    const v: number[] = [];
    const uv: number[] = [];
    face.forEach((u, c) => {
      for (const x of corners.get(ckey(u, f)) ?? [u]) {
        v.push(x);
        const t = x === u || !rec.uv ? uvOf(rec, c) : (frameOf(f)?.at(vpos(m, x), c) ?? uvOf(rec, c));
        uv.push(t[0], t[1]);
        cornerUV.set(`${f}:${x}`, t);
      }
    });
    out.push({ ...rec, v, uv: rec.uv ? uv : null });
  }
  const vertexUV = new Map<number, [number, number]>();
  for (const [k, t] of cornerUV) {
    const x = Number(k.slice(k.indexOf(':') + 1));
    if (!vertexUV.has(x)) vertexUV.set(x, t);
  }

  // ---------------------------------------------------------------- strips
  const strips: FaceRec[] = [];
  const shared = new Map<string, { from: number; mid: number[]; count: number }>();
  const profiles = new Map<string, Profile>();
  const centersByVertex = new Map<number, V3[]>();
  const profileAt = (u: number, e: number, x: number, y: number): Profile => {
    const key = `${u}:${e}`;
    const have = profiles.get(key);
    if (have) return have;
    const [lo, hi] = topo.edges[e];
    const other = lo === u ? hi : lo;
    const A = vpos(m, x);
    const B = vpos(m, y);
    // Corner of the profile: point on the original edge line at the rails' station.
    const pu = vpos(src, u);
    const dir = norm(sub(vpos(src, other), pu));
    const midAB = mul(add(A, B), 0.5);
    const V = add(pu, mul(dir, dot(sub(midAB, pu), dir)));
    const pts = profilePoints(A, B, V, segs, r);
    const pairKey = x < y ? `${x},${y}` : `${y},${x}`;
    let mid: number[];
    const sh = shared.get(pairKey);
    if (sh && segs > 1) {
      // Two strips meet without a corner patch: share the profile (average both shapes).
      mid = sh.from === x ? sh.mid : sh.mid.slice().reverse();
      mid.forEach((vv, i) =>
        setVpos(m, vv, mul(add(mul(vpos(m, vv), sh.count), pts[i]), 1 / (sh.count + 1))),
      );
      sh.count++;
    } else {
      mid = pts.map((p) => newVert(p, u));
      shared.set(pairKey, { from: x, mid, count: 1 });
    }
    const prof = { verts: [x, ...mid, y], center: sub(add(A, B), V) };
    profiles.set(key, prof);
    pushTo(centersByVertex, u, prof.center);
    return prof;
  };
  for (const e of [...beveled].sort((a, b) => a - b)) {
    const [lo, hi] = topo.edges[e];
    const [f1, f2] = topo.edgeFaces[e];
    const X = traverses(f1, lo, hi) ? f1 : f2;
    const Y = X === f1 ? f2 : f1;
    const first = (u: number, f: number) => corners.get(ckey(u, f))![0];
    const last = (u: number, f: number) => {
      const l = corners.get(ckey(u, f))!;
      return l[l.length - 1];
    };
    const pLo = profileAt(lo, e, last(lo, X), first(lo, Y));
    const pHi = profileAt(hi, e, first(hi, X), last(hi, Y));
    const uvAlong = (p: Profile, xf: number, yf: number): [number, number][] => {
      const ux = cornerUV.get(`${xf}:${p.verts[0]}`) ?? [0, 0];
      const uy = cornerUV.get(`${yf}:${p.verts[segs]}`) ?? [0, 0];
      return p.verts.map((vv, i) => {
        const t = i / segs;
        const uv: [number, number] = [ux[0] + (uy[0] - ux[0]) * t, ux[1] + (uy[1] - ux[1]) * t];
        if (!vertexUV.has(vv)) vertexUV.set(vv, uv);
        return uv;
      });
    };
    const uLo = uvAlong(pLo, X, Y);
    const uHi = uvAlong(pHi, X, Y);
    for (let i = 0; i < segs; i++) {
      strips.push({
        v: [pHi.verts[i], pLo.verts[i], pLo.verts[i + 1], pHi.verts[i + 1]],
        mat: recs[X].mat,
        smooth: recs[X].smooth,
        uv: m.uvs ? [...uHi[i], ...uLo[i], ...uLo[i + 1], ...uHi[i + 1]] : null,
        sel: true,
      });
    }
  }

  // ---------------------------------------------------------------- corner patches
  const all = [...out, ...strips];
  const half = new Set<number>();
  for (const rec of all)
    for (let i = 0; i < rec.v.length; i++) half.add(dkey(rec.v[i], rec.v[(i + 1) % rec.v.length]));
  const unpaired = new Map<number, Map<number, number[]>>(); // owner → (a → [b, ...])
  const facesOfV = new Map<number, number[]>(); // original vertex → indices into `all` using it
  all.forEach((rec, fi) => {
    for (let i = 0; i < rec.v.length; i++) {
      const a = rec.v[i];
      const b = rec.v[(i + 1) % rec.v.length];
      if (affectedSet.has(a)) pushTo(facesOfV, a, fi);
      const oa = owner.get(a);
      if (oa === undefined || owner.get(b) !== oa || half.has(dkey(b, a))) continue;
      let mp = unpaired.get(oa);
      if (!mp) unpaired.set(oa, (mp = new Map()));
      pushTo(mp, a, b);
    }
  });
  const patches: FaceRec[] = [];
  for (const v of affected) {
    const mp = unpaired.get(v);
    if (!mp) continue;
    // Holes are closed chains of unpaired half-edges. The original vertex can lie on several holes
    // (e.g. two separate beveled edges at a pole), so chains through it are started there.
    const usedEdge = new Set<number>();
    const take = (a: number): number | undefined => {
      for (const b of mp.get(a) ?? [])
        if (!usedEdge.has(dkey(a, b))) {
          usedEdge.add(dkey(a, b));
          return b;
        }
      return undefined;
    };
    const starts = [...(mp.get(v) ?? []).map(() => v), ...[...mp.keys()].filter((a) => a !== v)];
    for (const start of starts) {
      let cur = take(start);
      if (cur === undefined) continue;
      const cycle = [start];
      while (cur !== undefined && cur !== start && cycle.length <= usedEdge.size) {
        cycle.push(cur);
        cur = take(cur);
      }
      if (cur !== start || cycle.length < 3) continue;
      const fanFace = fanOf(v)!.faces[0];
      const like = recs[fanFace];
      // Terminal edge: merge the patch into the only other face using v.
      const vi = cycle.indexOf(v);
      const users = (facesOfV.get(v) ?? []).filter((fi) => all[fi].v.includes(v));
      if (vi >= 0 && users.length === 1) {
        const g = all[users[0]];
        const gi = g.v.indexOf(v);
        const n = g.v.length;
        const c = cycle.length;
        const p = cycle[(vi + c - 1) % c];
        const q = cycle[(vi + 1) % c];
        if (g.v[(gi + n - 1) % n] === p && g.v[(gi + 1) % n] === q) {
          // The hole runs v → q → ... → p → v; its inner part replaces v in g (reversed).
          const path: number[] = [];
          for (let k = 2; k < c - 1; k++) path.push(cycle[(vi + k) % c]);
          path.reverse();
          const origFace = users[0] < out.length ? users[0] : -1;
          const corner = origFace >= 0 ? src.faces[origFace].indexOf(v) : -1;
          const frame = origFace >= 0 ? frameOf(origFace) : null;
          const guv = g.uv;
          const newUV = path.flatMap((x) =>
            frame && corner >= 0 ? frame.at(vpos(m, x), corner) : (vertexUV.get(x) ?? [0, 0]),
          );
          g.v.splice(gi, 1, ...path);
          if (guv) guv.splice(gi * 2, 2, ...newUV);
          continue;
        }
      }
      const loop = cycle.slice().reverse();
      const uvOfV = (x: number): [number, number] =>
        vertexUV.get(x) ?? cornerUV.get(`${fanFace}:${x}`) ?? uvOf(like, src.faces[fanFace].indexOf(v));
      const railIdx = loop.map((x, i) => (rails.has(x) ? i : -1)).filter((i) => i >= 0);
      if (
        segs > 1 &&
        loop.length === 3 * segs &&
        railIdx.length === 3 &&
        railIdx.every((x, i) => x - railIdx[0] === i * segs)
      ) {
        patches.push(
          ...triPatch(
            m,
            loop.slice(railIdx[0]).concat(loop.slice(0, railIdx[0])),
            segs,
            like,
            uvOfV,
            sphereFit(m, loop, v, vertexMode ? [] : centersAt(v)),
          ),
        );
      } else if (loop.length <= 4 || segs === 1) {
        patches.push({
          v: loop,
          mat: like.mat,
          smooth: like.smooth,
          uv: m.uvs ? loop.flatMap(uvOfV) : null,
          sel: true,
        });
      } else {
        // Fan around a center vertex (pushed onto the fitted sphere when possible).
        const pts = loop.map((x) => vpos(m, x));
        let c: V3 = mul(
          pts.reduce((acc, p) => add(acc, p), [0, 0, 0] as V3),
          1 / pts.length,
        );
        const fit = sphereFit(m, loop, v, vertexMode ? [] : centersAt(v));
        if (fit) c = add(fit.center, mul(norm(sub(c, fit.center)), fit.radius));
        const cv = newVert(c, v);
        const uvs = loop.map(uvOfV);
        const cu: [number, number] = [
          uvs.reduce((a, t) => a + t[0], 0) / uvs.length,
          uvs.reduce((a, t) => a + t[1], 0) / uvs.length,
        ];
        for (let i = 0; i < loop.length; i++) {
          const j = (i + 1) % loop.length;
          patches.push({
            v: [loop[i], loop[j], cv],
            mat: like.mat,
            smooth: like.smooth,
            uv: m.uvs ? [...uvs[i], ...uvs[j], ...cu] : null,
            sel: true,
          });
        }
      }
    }
  }

  function centersAt(v: number): V3[] {
    return centersByVertex.get(v) ?? [];
  }

  // ---------------------------------------------------------------- edge attributes
  for (const k of Object.keys(src.edgeAttrs)) {
    const e = topo.edgeIndex.get(k);
    if (e === undefined || beveled.has(e)) continue;
    const [a, b] = topo.edges[e];
    const na = slideOn.get(`${a}:${e}`) ?? a;
    const nb = slideOn.get(`${b}:${e}`) ?? b;
    if (na !== a || nb !== b) m.edgeAttrs[edgeKey(na, nb)] = { ...src.edgeAttrs[k] };
  }

  const selected = writeFaces(m, [...all, ...patches]);
  pruneEdgeData(m);
  removeUnusedAmong(m, [...affected, ...created]);
  return { mesh: m, selection: selectionFromFaces(m, selected) };
}

/** Sphere through a corner patch, if the boundary is (nearly) equidistant from the profile centers. */
function sphereFit(
  m: MeshData,
  loop: number[],
  _v: number,
  centers: V3[],
): { center: V3; radius: number } | null {
  if (centers.length === 0) return null;
  const c = mul(
    centers.reduce((a, p) => add(a, p), [0, 0, 0] as V3),
    1 / centers.length,
  );
  const ds = loop.map((x) => len(sub(vpos(m, x), c)));
  const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
  if (mean < 1e-12) return null;
  const dev = Math.max(...ds.map((d) => Math.abs(d - mean)));
  return dev / mean < 0.03 ? { center: c, radius: mean } : null;
}

/**
 * Fills a triangular corner patch whose boundary loop has 3·n vertices (corners at 0, n, 2n) with
 * a triangle grid. Interior points blend the three boundary curves and are projected onto the
 * fitted sphere when available.
 */
function triPatch(
  m: MeshData,
  loop: number[],
  n: number,
  like: FaceRec,
  uvOfV: (x: number) => [number, number],
  fit: { center: V3; radius: number } | null,
): FaceRec[] {
  const L = loop.length;
  const at = (i: number) => loop[((i % L) + L) % L];
  // Boundary: P(i,0) = loop[i]; P(n-j, j) = loop[n + j]; P(0, j) = loop[3n - j].
  const idx: number[][] = [];
  const uvs: [number, number][][] = [];
  const bnd = (i: number, j: number): number | null => {
    if (j === 0) return at(i);
    if (i + j === n) return at(n + j);
    if (i === 0) return at(3 * n - j);
    return null;
  };
  const P = (x: number) => vpos(m, x);
  for (let i = 0; i <= n; i++) {
    idx.push([]);
    uvs.push([]);
    for (let j = 0; i + j <= n; j++) {
      const b = bnd(i, j);
      if (b !== null) {
        idx[i].push(b);
        uvs[i].push(uvOfV(b));
        continue;
      }
      const k = n - i - j;
      const lerp = (a: V3, c: V3, t: number): V3 => add(a, mul(sub(c, a), t));
      const lerp2 = (a: [number, number], c: [number, number], t: number): [number, number] => [
        a[0] + (c[0] - a[0]) * t,
        a[1] + (c[1] - a[1]) * t,
      ];
      const e2 = (jj: number) => at(3 * n - jj);
      const e1 = (jj: number) => at(n + jj);
      const p1 = lerp(P(e2(j)), P(e1(j)), i / (n - j));
      const p2 = lerp(P(at(i)), P(e1(n - i)), j / (n - i));
      const p3 = lerp(P(at(n - k)), P(e2(n - k)), j / (n - k));
      let p = mul(add(add(p1, p2), p3), 1 / 3);
      if (fit) p = add(fit.center, mul(norm(sub(p, fit.center)), fit.radius));
      const u1 = lerp2(uvOfV(e2(j)), uvOfV(e1(j)), i / (n - j));
      const u2 = lerp2(uvOfV(at(i)), uvOfV(e1(n - i)), j / (n - i));
      const u3 = lerp2(uvOfV(at(n - k)), uvOfV(e2(n - k)), j / (n - k));
      const x = addVertexFrom(m, p, [loop[0], loop[n], loop[2 * n]]);
      idx[i].push(x);
      uvs[i].push([(u1[0] + u2[0] + u3[0]) / 3, (u1[1] + u2[1] + u3[1]) / 3]);
    }
  }
  const out: FaceRec[] = [];
  const tri = (a: [number, number], b: [number, number], c: [number, number]) =>
    out.push({
      v: [idx[a[0]][a[1]], idx[b[0]][b[1]], idx[c[0]][c[1]]],
      mat: like.mat,
      smooth: like.smooth,
      uv: m.uvs ? [...uvs[a[0]][a[1]], ...uvs[b[0]][b[1]], ...uvs[c[0]][c[1]]] : null,
      sel: true,
    });
  for (let i = 0; i < n; i++)
    for (let j = 0; i + j < n; j++) {
      tri([i, j], [i + 1, j], [i, j + 1]);
      if (i + j <= n - 2) tri([i + 1, j], [i + 1, j + 1], [i, j + 1]);
    }
  return out;
}
