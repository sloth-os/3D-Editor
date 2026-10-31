import { z } from 'zod';
import type { MeshData } from '../mesh/types';
import { compactVertices, pruneEdgeData, vertexCount } from '../mesh/types';
import { buildTopology, type Topology } from '../mesh/topology';
import type { ModifierDef } from './registry';
import { DEG, MeshBuilder, faceNormalsOf, hasColors } from './util';
import { mergeLoops } from './polymerge';

/*
 * Self-contained bevel modifier (independent of the edit-mode bevel tool).
 *
 * Edge mode: every selected edge becomes a strip of `segments` quads following a superellipse profile,
 * faces shrink away from beveled edges, and every affected vertex gets a patch polygon (fan-filled for
 * segments > 1). Where beveled and non-beveled edges meet, the new vertices slide along the non-beveled
 * edges and the neighbouring faces receive the extra vertices, so closed inputs stay closed.
 * Vertex mode: corners are cut off at `width` along each incident edge.
 *
 * Limitations: only manifold vertices with a closed face fan are beveled (boundary and non-manifold
 * vertices/edges are left as they are), the width is clamped globally (`use_clamp_overlap`) and vertex
 * patches with several segments are filled with a triangle fan instead of a quad grid.
 */

const schema = z.object({
  width: z.number().min(0).default(0.1).describe('Bevel offset distance from the original edge/vertex'),
  segments: z.number().int().min(1).max(100).default(1).describe('Number of segments across the bevel'),
  limit_method: z
    .enum(['NONE', 'ANGLE'])
    .default('ANGLE')
    .describe('NONE bevels every edge; ANGLE only edges whose faces meet at more than angle_limit'),
  angle_limit: z
    .number()
    .min(0)
    .max(Math.PI)
    .default(30 * DEG)
    .describe('Minimum angle (radians) between faces for ANGLE'),
  affect: z.enum(['EDGES', 'VERTICES']).default('EDGES').describe('Bevel edges or only vertices (corners)'),
  profile: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe('Profile shape: 0.5 round, 0.25 straight, 1 boxy, <0.25 concave'),
  material: z
    .number()
    .int()
    .min(-1)
    .default(-1)
    .describe('Material index for new faces (-1 = from the adjacent face)'),
  use_clamp_overlap: z
    .boolean()
    .default(true)
    .describe('Limit the width so neighbouring bevels do not overlap'),
  harden_normals: z.boolean().default(false).describe('Accepted for compatibility (no effect)'),
});

type BevelParams = z.infer<typeof schema>;

interface Ring {
  faces: number[];
  corners: number[];
  eIn: number[];
  eOut: number[];
}

/** Faces around an interior manifold vertex in fan order (null for boundary / non-manifold vertices). */
function vertexRing(m: MeshData, topo: Topology, dirFace: Map<string, number>, v: number): Ring | null {
  const vf = topo.vertFaces[v];
  if (vf.length === 0) return null;
  const ring: Ring = { faces: [], corners: [], eIn: [], eOut: [] };
  let f = vf[0];
  for (let guard = 0; guard <= vf.length; guard++) {
    const face = m.faces[f];
    const i = face.indexOf(v);
    const L = face.length;
    ring.faces.push(f);
    ring.corners.push(i);
    ring.eIn.push(topo.faceEdges[f][(i + L - 1) % L]);
    ring.eOut.push(topo.faceEdges[f][i]);
    const next = dirFace.get(`${face[(i + 1) % L]},${v}`);
    if (next === undefined) return null;
    if (next === vf[0]) break;
    f = next;
  }
  if (ring.faces.length !== new Set(vf).size || new Set(ring.faces).size !== ring.faces.length) return null;
  return ring;
}

/** Superellipse profile point between A (t=0) and B (t=1) bulging toward control point C. */
function profilePoint(A: number[], B: number[], C: number[], t: number, profile: number): number[] {
  const k = Math.max(0.1, Math.min(40, 4 * profile));
  const th = (t * Math.PI) / 2;
  const x = 1 - Math.pow(Math.sin(th), 2 / k);
  const y = 1 - Math.pow(Math.cos(th), 2 / k);
  return [0, 1, 2].map((i) => C[i] + (A[i] - C[i]) * x + (B[i] - C[i]) * y);
}

function sub(P: ArrayLike<number>, a: number, b: number): number[] {
  return [P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]];
}

function norm(v: number[]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/** UV at position `pt` inside face f's corner i, by decomposing pt − v in the corner's edge basis. */
function cornerUV(m: MeshData, f: number, i: number, pt: number[]): number[] {
  const uv = m.uvs?.[f];
  if (!uv) return [0, 0];
  const face = m.faces[f];
  const L = face.length;
  const v = face[i];
  const ip = (i + L - 1) % L;
  const inx = (i + 1) % L;
  const P = m.positions;
  const a = sub(P, face[ip], v);
  const b = sub(P, face[inx], v);
  const w = [pt[0] - P[v * 3], pt[1] - P[v * 3 + 1], pt[2] - P[v * 3 + 2]];
  const aa = a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
  const ab = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const bb = b[0] * b[0] + b[1] * b[1] + b[2] * b[2];
  const wa = w[0] * a[0] + w[1] * a[1] + w[2] * a[2];
  const wb = w[0] * b[0] + w[1] * b[1] + w[2] * b[2];
  const det = aa * bb - ab * ab;
  const al = Math.abs(det) > 1e-24 ? (wa * bb - wb * ab) / det : 0;
  const be = Math.abs(det) > 1e-24 ? (wb * aa - wa * ab) / det : 0;
  return [
    uv[i * 2] + al * (uv[ip * 2] - uv[i * 2]) + be * (uv[inx * 2] - uv[i * 2]),
    uv[i * 2 + 1] + al * (uv[ip * 2 + 1] - uv[i * 2 + 1]) + be * (uv[inx * 2 + 1] - uv[i * 2 + 1]),
  ];
}

interface PatchCtx {
  b: MeshBuilder;
  vertUV: Map<number, number[]>;
  material: number;
  smooth: boolean;
}

/** Adds a vertex patch: an n-gon, or a triangle fan around a center point when `fanCenter` is given. */
function addPatch(
  ctx: PatchCtx,
  loop: number[],
  fanCenter: number[] | null,
  colorSrc: number[] | null,
  colorIndex: number,
): void {
  const uvOf = (v: number) => ctx.vertUV.get(v) ?? [0, 0];
  if (!fanCenter || loop.length <= 4) {
    ctx.b.addFace(loop, ctx.material, ctx.smooth, loop.flatMap(uvOf));
    return;
  }
  const c = ctx.b.addVertex(fanCenter[0], fanCenter[1], fanCenter[2], colorSrc, colorIndex);
  const cu = [0, 0];
  for (const v of loop) {
    const u = uvOf(v);
    cu[0] += u[0] / loop.length;
    cu[1] += u[1] / loop.length;
  }
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const d = loop[(i + 1) % loop.length];
    ctx.b.addFace([c, a, d], ctx.material, ctx.smooth, [...cu, ...uvOf(a), ...uvOf(d)]);
  }
}

export function bevelMesh(m: MeshData, p: BevelParams): MeshData {
  if (p.width <= 0 || m.faces.length === 0) return m;
  const topo = buildTopology(m);
  const nv = vertexCount(m);
  const fn = faceNormalsOf(m);
  const dirFace = new Map<string, number>();
  m.faces.forEach((f, i) => {
    for (let k = 0; k < f.length; k++) dirFace.set(`${f[k]},${f[(k + 1) % f.length]}`, i);
  });
  const rings: (Ring | null)[] = new Array(nv).fill(null);
  for (let v = 0; v < nv; v++) rings[v] = vertexRing(m, topo, dirFace, v);
  const cosLimit = Math.cos(p.angle_limit);
  const sharpEdge = (e: number) => {
    const fs = topo.edgeFaces[e];
    if (fs.length !== 2) return false;
    if (p.limit_method === 'NONE') return true;
    const [f, g] = fs;
    return (
      fn[f * 3] * fn[g * 3] + fn[f * 3 + 1] * fn[g * 3 + 1] + fn[f * 3 + 2] * fn[g * 3 + 2] < cosLimit - 1e-9
    );
  };
  return p.affect === 'VERTICES'
    ? bevelVertices(m, p, topo, rings, sharpEdge)
    : bevelEdges(m, p, topo, rings, fn, dirFace, sharpEdge);
}

function bevelEdges(
  m: MeshData,
  p: BevelParams,
  topo: Topology,
  rings: (Ring | null)[],
  fn: Float64Array,
  dirFace: Map<string, number>,
  sharpEdge: (e: number) => boolean,
): MeshData {
  const nv = vertexCount(m);
  const P = m.positions;
  const ne = topo.edges.length;
  const isB = new Uint8Array(ne);
  let any = false;
  for (let e = 0; e < ne; e++) {
    const [a, b] = topo.edges[e];
    if (!rings[a] || !rings[b] || !sharpEdge(e)) continue;
    if (norm(sub(P, a, b)) < 1e-12) continue;
    isB[e] = 1;
    any = true;
  }
  if (!any) return m;
  const S = p.segments;
  const colors = hasColors(m) ? m.colors! : null;
  const other = (e: number, v: number) => (topo.edges[e][0] === v ? topo.edges[e][1] : topo.edges[e][0]);
  const edgeLen = (e: number) => norm(sub(P, topo.edges[e][0], topo.edges[e][1]));

  // --- per-corner offsets for unit width
  type Corner = { kind: 'M' | 'SLIDE' | 'V'; w?: number[]; e?: number; t?: number };
  const corners = new Map<string, Corner>();
  const ck = (f: number, i: number) => `${f}:${i}`;
  let scaleLimit = Infinity;
  for (let v = 0; v < nv; v++) {
    const ring = rings[v];
    if (!ring || !ring.eIn.some((e) => isB[e])) continue;
    for (let k = 0; k < ring.faces.length; k++) {
      const f = ring.faces[k];
      const i = ring.corners[k];
      const face = m.faces[f];
      const L = face.length;
      const bIn = isB[ring.eIn[k]] === 1;
      const bOut = isB[ring.eOut[k]] === 1;
      const prev = face[(i + L - 1) % L];
      const next = face[(i + 1) % L];
      const dPrev = sub(P, prev, v);
      const dNext = sub(P, next, v);
      const lPrev = norm(dPrev);
      const lNext = norm(dNext);
      const uPrev = dPrev.map((x) => x / (lPrev || 1));
      const uNext = dNext.map((x) => x / (lNext || 1));
      const cosA = uPrev[0] * uNext[0] + uPrev[1] * uNext[1] + uPrev[2] * uNext[2];
      const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
      if (bIn && bOut) {
        // point at unit distance from both edges inside the face
        const nx = fn[f * 3];
        const ny = fn[f * 3 + 1];
        const nz = fn[f * 3 + 2];
        const e0 = uPrev.map((x) => -x); // direction prev → v
        const in0 = [ny * e0[2] - nz * e0[1], nz * e0[0] - nx * e0[2], nx * e0[1] - ny * e0[0]];
        const in1 = [
          ny * uNext[2] - nz * uNext[1],
          nz * uNext[0] - nx * uNext[2],
          nx * uNext[1] - ny * uNext[0],
        ];
        const c = in0[0] * in1[0] + in0[1] * in1[1] + in0[2] * in1[2];
        const w = [0, 1, 2].map((q) => (in0[q] + in1[q]) / Math.max(1 + c, 1e-3));
        corners.set(ck(f, i), { kind: 'M', w });
        const projPrev = Math.abs(w[0] * uPrev[0] + w[1] * uPrev[1] + w[2] * uPrev[2]);
        const projNext = Math.abs(w[0] * uNext[0] + w[1] * uNext[1] + w[2] * uNext[2]);
        if (projPrev > 1e-12) scaleLimit = Math.min(scaleLimit, (0.5 * lPrev) / projPrev);
        if (projNext > 1e-12) scaleLimit = Math.min(scaleLimit, (0.5 * lNext) / projNext);
      } else if (bIn || bOut) {
        const t = 1 / Math.max(sinA, 1e-3);
        const e = bOut ? ring.eIn[k] : ring.eOut[k];
        corners.set(ck(f, i), { kind: 'SLIDE', e, t });
        scaleLimit = Math.min(scaleLimit, (0.49 * edgeLen(e)) / t);
      } else corners.set(ck(f, i), { kind: 'V' });
    }
  }
  const width = p.use_clamp_overlap ? Math.min(p.width, scaleLimit) : p.width;

  const b = new MeshBuilder({ colors: !!colors, uvs: !!m.uvs });
  for (let v = 0; v < nv; v++) b.addVertex(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], colors, v);
  const vertUV = new Map<number, number[]>();
  const pos = (i: number) => [b.positions[i * 3], b.positions[i * 3 + 1], b.positions[i * 3 + 2]];

  // slide points: one per (vertex, edge), averaged over the requesting faces
  const slideReq = new Map<string, { v: number; e: number; sum: number; n: number }>();
  for (const [key, c] of corners) {
    if (c.kind !== 'SLIDE') continue;
    const f = Number(key.split(':')[0]);
    const i = Number(key.split(':')[1]);
    const v = m.faces[f][i];
    const sk = `${v}:${c.e}`;
    const r = slideReq.get(sk) ?? { v, e: c.e!, sum: 0, n: 0 };
    r.sum += c.t! * width;
    r.n++;
    slideReq.set(sk, r);
  }
  const slideVert = new Map<string, number>();
  const slideT = new Map<string, number>();
  for (const [sk, r] of slideReq) {
    const t = r.sum / r.n;
    const w = other(r.e, r.v);
    const d = sub(P, w, r.v);
    const l = norm(d) || 1;
    const idx = b.addVertex(
      P[r.v * 3] + (d[0] / l) * t,
      P[r.v * 3 + 1] + (d[1] / l) * t,
      P[r.v * 3 + 2] + (d[2] / l) * t,
      colors,
      r.v,
    );
    slideVert.set(sk, idx);
    slideT.set(sk, t / l);
  }
  // corner vertices
  const cornerVert = new Map<string, number>();
  const cornerUVs = new Map<string, number[]>();
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    for (let i = 0; i < face.length; i++) {
      const v = face[i];
      const c = corners.get(ck(f, i));
      let idx = v;
      if (c?.kind === 'M') {
        idx = b.addVertex(
          P[v * 3] + c.w![0] * width,
          P[v * 3 + 1] + c.w![1] * width,
          P[v * 3 + 2] + c.w![2] * width,
          colors,
          v,
        );
      } else if (c?.kind === 'SLIDE') idx = slideVert.get(`${v}:${c.e}`)!;
      cornerVert.set(ck(f, i), idx);
      const uv = cornerUV(m, f, i, pos(idx));
      cornerUVs.set(ck(f, i), uv);
      if (!vertUV.has(idx)) vertUV.set(idx, uv);
    }
  }
  const cornerOf = (f: number, v: number) => ck(f, m.faces[f].indexOf(v));

  // --- strips (with profile arcs at both ends)
  const arcs = new Map<string, number[]>(); // `${e}:${v}` → vertices from the first face side to the second
  const stripFace = (e: number): [number, number] => {
    const [a, c] = topo.edges[e];
    return [dirFace.get(`${a},${c}`) ?? -1, dirFace.get(`${c},${a}`) ?? -1];
  };
  const arcAt = (e: number, v: number): number[] => {
    const key = `${e}:${v}`;
    let arc = arcs.get(key);
    if (arc) return arc;
    const [fa, fb] = stripFace(e);
    const A = cornerVert.get(cornerOf(fa, v))!;
    const B = cornerVert.get(cornerOf(fb, v))!;
    arc = [A];
    if (S > 1) {
      const pa = pos(A);
      const pb = pos(B);
      // control point: the point of the edge line closest to the middle of A and B
      const w = other(e, v);
      const dir = sub(P, w, v);
      const dl = norm(dir) || 1;
      const mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
      const s =
        ((mid[0] - P[v * 3]) * dir[0] + (mid[1] - P[v * 3 + 1]) * dir[1] + (mid[2] - P[v * 3 + 2]) * dir[2]) /
        (dl * dl);
      const C = [P[v * 3] + dir[0] * s, P[v * 3 + 1] + dir[1] * s, P[v * 3 + 2] + dir[2] * s];
      const ua = vertUV.get(A) ?? [0, 0];
      const ub = vertUV.get(B) ?? [0, 0];
      for (let j = 1; j < S; j++) {
        const q = profilePoint(pa, pb, C, j / S, p.profile);
        const idx = b.addVertex(q[0], q[1], q[2], colors, v);
        vertUV.set(idx, [ua[0] + ((ub[0] - ua[0]) * j) / S, ua[1] + ((ub[1] - ua[1]) * j) / S]);
        arc.push(idx);
      }
    }
    arc.push(B);
    arcs.set(key, arc);
    return arc;
  };

  // --- original faces (shrunk), with slide points inserted along non-beveled edges
  const faceIndex: number[] = [];
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    const L = face.length;
    const loop: number[] = [];
    const luv: number[] = [];
    const uv = m.uvs?.[f];
    for (let i = 0; i < L; i++) {
      const v = face[i];
      const j = (i + 1) % L;
      const w = face[j];
      const cv = cornerVert.get(ck(f, i))!;
      if (!loop.length || loop[loop.length - 1] !== cv) {
        loop.push(cv);
        luv.push(...cornerUVs.get(ck(f, i))!);
      }
      const e = topo.faceEdges[f][i];
      if (isB[e]) continue;
      const pushSlide = (from: number, cornerIsV: boolean) => {
        const sk = `${from}:${e}`;
        const idx = slideVert.get(sk);
        if (idx === undefined || !cornerIsV) return;
        const t = slideT.get(sk)!;
        const tt = from === v ? t : 1 - t;
        loop.push(idx);
        luv.push(
          uv ? uv[i * 2] + (uv[j * 2] - uv[i * 2]) * tt : 0,
          uv ? uv[i * 2 + 1] + (uv[j * 2 + 1] - uv[i * 2 + 1]) * tt : 0,
        );
      };
      pushSlide(v, cv === v);
      pushSlide(w, cornerVert.get(ck(f, j)) === w);
    }
    while (loop.length > 1 && loop[0] === loop[loop.length - 1]) {
      loop.pop();
      luv.length -= 2;
    }
    faceIndex.push(
      loop.length >= 3 ? b.addFace(loop, m.faceMaterials[f] ?? 0, m.faceSmooth[f] ?? false, luv) : -1,
    );
  }

  // --- strips
  for (let e = 0; e < ne; e++) {
    if (!isB[e]) continue;
    const [u, w] = topo.edges[e];
    const [fa] = stripFace(e);
    const au = arcAt(e, u);
    const aw = arcAt(e, w);
    const mat = p.material >= 0 ? p.material : (m.faceMaterials[fa] ?? 0);
    const smooth = m.faceSmooth[fa] ?? false;
    for (let j = 0; j < S; j++) {
      const quad = [aw[j], au[j], au[j + 1], aw[j + 1]];
      b.addFace(
        quad,
        mat,
        smooth,
        quad.flatMap((x) => vertUV.get(x) ?? [0, 0]),
      );
    }
  }

  // --- vertex patches
  for (let v = 0; v < nv; v++) {
    const ring = rings[v];
    if (!ring || !ring.eIn.some((e) => isB[e])) continue;
    const n = ring.faces.length;
    const seq: number[] = [];
    const push = (x: number) => {
      if (seq[seq.length - 1] !== x) seq.push(x);
    };
    for (let k = 0; k < n; k++) {
      const e = ring.eIn[k];
      const fPrev = ring.faces[(k + n - 1) % n];
      if (isB[e]) {
        const arc = arcAt(e, v);
        const [fa] = stripFace(e);
        for (const x of fa === fPrev ? arc : arc.slice().reverse()) push(x);
      } else {
        const sv = slideVert.get(`${v}:${e}`);
        if (sv !== undefined) push(sv);
      }
      push(cornerVert.get(ck(ring.faces[k], ring.corners[k]))!);
    }
    while (seq.length > 1 && seq[0] === seq[seq.length - 1]) seq.pop();
    if (seq.length < 3) continue;
    const loop = seq.reverse();
    const f0 = ring.faces[0];
    const ctx: PatchCtx = {
      b,
      vertUV,
      material: p.material >= 0 ? p.material : (m.faceMaterials[f0] ?? 0),
      smooth: m.faceSmooth[f0] ?? false,
    };
    // merge a patch that still contains the original vertex into its (single, coplanar) face
    if (loop.includes(v)) {
      const keepers = ring.faces.filter((f, k) => cornerVert.get(ck(f, ring.corners[k])) === v);
      if (keepers.length === 1 && faceIndex[keepers[0]] >= 0) {
        const fi = faceIndex[keepers[0]];
        const fl = b.faces[fi];
        const nrm = fn.slice(keepers[0] * 3, keepers[0] * 3 + 3);
        const planar = loop.every((x) => {
          const d = [
            b.positions[x * 3] - P[v * 3],
            b.positions[x * 3 + 1] - P[v * 3 + 1],
            b.positions[x * 3 + 2] - P[v * 3 + 2],
          ];
          return Math.abs(d[0] * nrm[0] + d[1] * nrm[1] + d[2] * nrm[2]) <= 1e-6 * (norm(d) + 1e-12) + 1e-9;
        });
        const merged = planar
          ? mergeLoops(
              { verts: fl, uvs: b.uvs ? b.uvs[fi] : null },
              { verts: loop, uvs: b.uvs ? loop.flatMap((x) => vertUV.get(x) ?? [0, 0]) : null },
            )
          : null;
        if (merged) {
          b.faces[fi] = merged.verts;
          if (b.uvs && merged.uvs) b.uvs[fi] = merged.uvs;
          continue;
        }
      }
      addPatch(ctx, loop, null, colors, v);
      continue;
    }
    let center: number[] | null = null;
    if (S > 1) {
      const c = [0, 0, 0];
      for (const x of loop) for (let q = 0; q < 3; q++) c[q] += b.positions[x * 3 + q] / loop.length;
      center = [0, 1, 2].map((q) => c[q] + (P[v * 3 + q] - c[q]) * 0.5);
    }
    addPatch(ctx, loop, center, colors, v);
  }
  // edge attributes of non-beveled edges are kept on the edge (and its slid parts)
  for (const key in m.edgeAttrs) {
    const e = topo.edgeIndex.get(key);
    if (e === undefined || isB[e]) continue;
    const [a, c] = topo.edges[e];
    const sa = slideVert.get(`${a}:${e}`) ?? a;
    const sc = slideVert.get(`${c}:${e}`) ?? c;
    b.setEdgeAttr(sa, sc, m.edgeAttrs[key]);
    if (sa !== a) b.setEdgeAttr(a, sa, m.edgeAttrs[key]);
    if (sc !== c) b.setEdgeAttr(sc, c, m.edgeAttrs[key]);
  }
  for (let i = 0; i + 1 < m.looseEdges.length; i += 2) b.addLooseEdge(m.looseEdges[i], m.looseEdges[i + 1]);
  const out = b.build();
  pruneEdgeData(out);
  compactVertices(out);
  return out;
}

function bevelVertices(
  m: MeshData,
  p: BevelParams,
  topo: Topology,
  rings: (Ring | null)[],
  sharpEdge: (e: number) => boolean,
): MeshData {
  const nv = vertexCount(m);
  const P = m.positions;
  const S = p.segments;
  const colors = hasColors(m) ? m.colors! : null;
  const sel = new Uint8Array(nv);
  let any = false;
  for (let v = 0; v < nv; v++) {
    const ring = rings[v];
    if (!ring) continue;
    if (p.limit_method === 'ANGLE' && !topo.vertEdges[v].some(sharpEdge)) continue;
    sel[v] = 1;
    any = true;
  }
  if (!any) return m;
  let width = p.width;
  if (p.use_clamp_overlap) {
    for (let e = 0; e < topo.edges.length; e++) {
      const [a, c] = topo.edges[e];
      const ends = sel[a] + sel[c];
      if (ends) width = Math.min(width, (norm(sub(P, a, c)) / ends) * 0.98);
    }
  }
  const b = new MeshBuilder({ colors: !!colors, uvs: !!m.uvs });
  for (let v = 0; v < nv; v++) b.addVertex(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], colors, v);
  const cut = new Map<string, number>(); // `${v}:${e}` → vertex on edge e at distance `width` from v
  const cutAt = (v: number, e: number) => {
    const key = `${v}:${e}`;
    let idx = cut.get(key);
    if (idx === undefined) {
      const w = topo.edges[e][0] === v ? topo.edges[e][1] : topo.edges[e][0];
      const d = sub(P, w, v);
      const l = norm(d) || 1;
      idx = b.addVertex(
        P[v * 3] + (d[0] / l) * width,
        P[v * 3 + 1] + (d[1] / l) * width,
        P[v * 3 + 2] + (d[2] / l) * width,
        colors,
        v,
      );
      cut.set(key, idx);
    }
    return idx;
  };
  const vertUV = new Map<number, number[]>();
  // per face corner: the arc from the cut on the incoming edge to the cut on the outgoing edge
  const cornerArc = new Map<string, number[]>();
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    const L = face.length;
    const loop: number[] = [];
    const luv: number[] = [];
    for (let i = 0; i < L; i++) {
      const v = face[i];
      if (!sel[v]) {
        loop.push(v);
        const uv = cornerUV(m, f, i, [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
        luv.push(...uv);
        if (!vertUV.has(v)) vertUV.set(v, uv);
        continue;
      }
      const eIn = topo.faceEdges[f][(i + L - 1) % L];
      const eOut = topo.faceEdges[f][i];
      const a = cutAt(v, eIn);
      const c = cutAt(v, eOut);
      const arc = [a];
      const pa = [b.positions[a * 3], b.positions[a * 3 + 1], b.positions[a * 3 + 2]];
      const pc = [b.positions[c * 3], b.positions[c * 3 + 1], b.positions[c * 3 + 2]];
      for (let j = 1; j < S; j++) {
        const q = profilePoint(pa, pc, [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]], j / S, p.profile);
        arc.push(b.addVertex(q[0], q[1], q[2], colors, v));
      }
      arc.push(c);
      cornerArc.set(`${f}:${i}`, arc);
      for (const x of arc) {
        const uv = cornerUV(m, f, i, [b.positions[x * 3], b.positions[x * 3 + 1], b.positions[x * 3 + 2]]);
        loop.push(x);
        luv.push(...uv);
        if (!vertUV.has(x)) vertUV.set(x, uv);
      }
    }
    b.addFace(loop, m.faceMaterials[f] ?? 0, m.faceSmooth[f] ?? false, luv);
  }
  for (let v = 0; v < nv; v++) {
    if (!sel[v]) continue;
    const ring = rings[v]!;
    const seq: number[] = [];
    // walk the fan backwards so the patch is wound opposite to the face corners it borders
    for (let k = ring.faces.length - 1; k >= 0; k--) {
      const arc = cornerArc.get(`${ring.faces[k]}:${ring.corners[k]}`)!;
      for (let j = arc.length - 1; j >= 0; j--) if (seq[seq.length - 1] !== arc[j]) seq.push(arc[j]);
    }
    while (seq.length > 1 && seq[0] === seq[seq.length - 1]) seq.pop();
    if (seq.length < 3) continue;
    const f0 = ring.faces[0];
    let center: number[] | null = null;
    if (S > 1) {
      const c = [0, 0, 0];
      for (const x of seq) for (let q = 0; q < 3; q++) c[q] += b.positions[x * 3 + q] / seq.length;
      center = [0, 1, 2].map((q) => c[q] + (P[v * 3 + q] - c[q]) * 0.5);
    }
    addPatch(
      {
        b,
        vertUV,
        material: p.material >= 0 ? p.material : (m.faceMaterials[f0] ?? 0),
        smooth: m.faceSmooth[f0] ?? false,
      },
      seq,
      center,
      colors,
      v,
    );
  }
  for (const key in m.edgeAttrs) {
    const e = topo.edgeIndex.get(key);
    if (e === undefined) continue;
    const [a, c] = topo.edges[e];
    b.setEdgeAttr(
      sel[a] ? (cut.get(`${a}:${e}`) ?? a) : a,
      sel[c] ? (cut.get(`${c}:${e}`) ?? c) : c,
      m.edgeAttrs[key],
    );
  }
  for (let i = 0; i + 1 < m.looseEdges.length; i += 2) b.addLooseEdge(m.looseEdges[i], m.looseEdges[i + 1]);
  const out = b.build();
  pruneEdgeData(out);
  compactVertices(out);
  return out;
}

export const bevelModifier: ModifierDef<typeof schema> = {
  type: 'BEVEL',
  label: 'Bevel',
  category: 'GENERATE',
  description:
    'Rounds or chamfers edges (or vertices): edges sharper than `angle_limit` (or all with limit_method NONE) are ' +
    'replaced by a strip of `segments` faces following `profile` (0.5 = round), offset by `width` into the adjacent ' +
    'faces; corners get patch faces. affect=VERTICES cuts off corners instead. Closed manifold input stays closed. ' +
    'Limitation: boundary / non-manifold vertices are not beveled.',
  schema,
  apply(mesh, p) {
    return bevelMesh(mesh, p);
  },
};
