import { z } from 'zod';
import type { MeshData } from '../mesh/types';
import { compactVertices, pruneEdgeData, vertexCount } from '../mesh/types';
import { buildTopology, type Topology } from '../mesh/topology';
import type { ModifierDef } from './registry';
import { DEG, MeshBuilder, faceNormalsOf, hasColors } from './util';
import { mergeLoops } from './polymerge';
import { fillGridPatch, patchFullness, type GridPatchContext, type PatchSide } from './bevel-patch';

/*
 * Self-contained bevel modifier (independent of the edit-mode bevel tool).
 *
 * Edge mode: every selected edge becomes a strip of `segments` quads following a superellipse profile,
 * faces shrink away from beveled edges, and every affected vertex gets a patch. Where beveled and
 * non-beveled edges meet, the new vertices slide along the non-beveled edges and the neighbouring faces
 * receive the extra vertices, so closed inputs stay closed. A vertex where just two beveled edges meet
 * with a single bevel vertex on each side (a cylinder rim, the middle of a beveled edge loop) needs no
 * patch: like Blender's weld, both strips share one profile chain. Where three or more beveled edges meet
 * (a cube corner, a cylinder rim with limit_method NONE), the patch between their profiles is a quad grid
 * like Blender's (see bevel-patch.ts); with one segment it is a single polygon.
 * Vertex mode: corners are cut off at `width` along each incident edge; with several segments the cut
 * is rounded by profiles across the faces and the same quad-grid patch.
 * Profiles are Blender's superellipses (profile 0.5 a circular arc, 1 a square corner) with their
 * segments spaced evenly along the curve. UVs are interpolated per face corner (see `BevelUVs`).
 *
 * Limitations: only manifold vertices with a closed face fan are beveled (boundary and non-manifold
 * vertices/edges are left as they are) and the width is clamped globally (`use_clamp_overlap`).
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
    .describe(
      'Profile shape (Blender superellipse): 0.5 round (circular arc), 0.25 straight chamfer, above 0.5 boxier up ' +
        'to 1 = square (the segments follow the original sharp edge), below 0.25 concave (values under 0.01 act as ' +
        '0.01). Segments are spaced evenly along the profile.',
    ),
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

/**
 * Superellipse exponent of a `profile` value, Blender's mapping (as the edit-mode bevel tool):
 * 0.5 → 2 (circle), 0.25 → 1 (straight), 1 → ∞ (square corner), 0 → 0 (inverted square).
 */
function profileExponent(profile: number): number {
  const p = Math.min(0.9999, Math.max(0.01, profile));
  return (-2 * Math.LN2) / Math.log(p);
}

/**
 * Arc-length tables of the quarter superellipse X^k + Y^k = 1 from (0, 1) to (1, 0), per exponent:
 * like Blender, profile vertices are spaced evenly along the curve, so boxy and concave profiles
 * keep their segments apart instead of bunching them in the corner (zero-area faces).
 */
const superellipseTables = new Map<number, { X: Float64Array; Y: Float64Array; s: Float64Array }>();

function superellipseTable(k: number): { X: Float64Array; Y: Float64Array; s: Float64Array } {
  let tab = superellipseTables.get(k);
  if (tab) return tab;
  const H = 256; // samples per half (from an end to the diagonal point)
  const d = Math.pow(2, -1 / k);
  const X = new Float64Array(2 * H + 1);
  const Y = new Float64Array(2 * H + 1);
  for (let i = 0; i <= H; i++) {
    // first half from (0, 1): X^k grows linearly in w for concave exponents, X itself otherwise
    const w = i / H;
    const x = k < 1 ? d * Math.pow(w, 1 / k) : d * w;
    const y = i === H ? d : Math.pow(Math.max(0, 1 - Math.pow(x, k)), 1 / k);
    X[i] = x;
    Y[i] = y;
    X[2 * H - i] = y; // the second half mirrors the first
    Y[2 * H - i] = x;
  }
  const s = new Float64Array(2 * H + 1);
  for (let i = 1; i <= 2 * H; i++) s[i] = s[i - 1] + Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]);
  for (let i = 1; i <= 2 * H; i++) s[i] /= s[2 * H];
  tab = { X, Y, s };
  if (superellipseTables.size > 64) superellipseTables.clear();
  superellipseTables.set(k, tab);
  return tab;
}

/**
 * Superellipse profile point between A (t=0) and B (t=1) bulging toward control point C, at the
 * fraction t of the curve's length (a round profile is an exact circular arc).
 */
function profilePoint(A: number[], B: number[], C: number[], t: number, profile: number): number[] {
  const k = profileExponent(profile);
  let X: number;
  let Y: number;
  if (k === 2) {
    X = Math.sin((t * Math.PI) / 2);
    Y = Math.cos((t * Math.PI) / 2);
  } else {
    const tab = superellipseTable(k);
    const tt = Math.min(1, Math.max(0, t));
    let lo = 0;
    let hi = tab.s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tab.s[mid] <= tt) lo = mid;
      else hi = mid;
    }
    const f = tab.s[hi] > tab.s[lo] ? (tt - tab.s[lo]) / (tab.s[hi] - tab.s[lo]) : 0;
    X = tab.X[lo] + (tab.X[hi] - tab.X[lo]) * f;
    Y = tab.Y[lo] + (tab.Y[hi] - tab.Y[lo]) * f;
  }
  const x = 1 - X;
  const y = 1 - Y;
  return [0, 1, 2].map((i) => C[i] + (A[i] - C[i]) * x + (B[i] - C[i]) * y);
}

function sub(P: ArrayLike<number>, a: number, b: number): number[] {
  return [P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]];
}

function norm(v: number[]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/**
 * Coordinates of position `pt` in face f's corner i: pt − v = al · (previous corner − v) + be · (next
 * corner − v), least squares (so pt is projected into the corner's plane); with `ab` the lengths of
 * those two edges.
 */
function cornerCoords(
  m: MeshData,
  f: number,
  i: number,
  pt: number[],
): { al: number; be: number; ab: number[] } {
  const face = m.faces[f];
  const L = face.length;
  const v = face[i];
  const P = m.positions;
  const a = sub(P, face[(i + L - 1) % L], v);
  const b = sub(P, face[(i + 1) % L], v);
  const w = [pt[0] - P[v * 3], pt[1] - P[v * 3 + 1], pt[2] - P[v * 3 + 2]];
  const aa = a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
  const ab = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const bb = b[0] * b[0] + b[1] * b[1] + b[2] * b[2];
  const wa = w[0] * a[0] + w[1] * a[1] + w[2] * a[2];
  const wb = w[0] * b[0] + w[1] * b[1] + w[2] * b[2];
  const det = aa * bb - ab * ab;
  return {
    al: Math.abs(det) > 1e-24 ? (wa * bb - wb * ab) / det : 0,
    be: Math.abs(det) > 1e-24 ? (wb * aa - wa * ab) / det : 0,
    ab: [Math.sqrt(aa), Math.sqrt(bb)],
  };
}

/** UV at position `pt` inside face f's corner i, by decomposing pt − v in the corner's edge basis. */
function cornerUV(m: MeshData, f: number, i: number, pt: number[]): number[] {
  const uv = m.uvs?.[f];
  if (!uv) return [0, 0];
  const L = m.faces[f].length;
  const ip = (i + L - 1) % L;
  const inx = (i + 1) % L;
  const { al, be } = cornerCoords(m, f, i, pt);
  return [
    uv[i * 2] + al * (uv[ip * 2] - uv[i * 2]) + be * (uv[inx * 2] - uv[i * 2]),
    uv[i * 2 + 1] + al * (uv[ip * 2 + 1] - uv[i * 2 + 1]) + be * (uv[inx * 2 + 1] - uv[i * 2 + 1]),
  ];
}

/** Where a new vertex lies relative to the faces around its original vertex (see `BevelUVs`). */
const enum HomeKind {
  /** Inside one original face's region (a miter corner, a profile point on that face's side). */
  FACE,
  /** On an original edge (a slide point, the middle of a profile, a patch sector boundary). */
  EDGE,
  /** At the original vertex (a patch center, the vertex itself). */
  VERT,
}

/**
 * Per-face-corner UVs of the new bevel geometry, interpolated like Blender: every new face takes its
 * UVs from one original face around the vertex its corners belong to, so bevel faces stay inside the
 * UV island of the face they were cut from instead of stretching across UV seams (a cylinder's rim
 * between the cap circles and the side strip, the wrap-around seam of its side).
 *
 * Every new vertex records its original vertex and its "home". In face F, a vertex at home in F takes
 * F's UV at its position (projected into F's plane); a vertex on an edge of F is first snapped onto
 * that edge; a vertex at home in a neighbouring face is snapped onto the edge F shares with it (or onto
 * the original vertex). So both halves of a bevel strip map onto their own face's island up to the
 * seam, and faces on both sides of an edge agree where the UVs are continuous. A face whose corners
 * lie in several faces' regions (the middle quad of an odd-segment strip, a corner patch) uses each
 * corner's own face where the UVs around it are continuous and one representative face otherwise.
 */
class BevelUVs {
  private readonly vert: number[] = [];
  private readonly kind: HomeKind[] = [];
  private readonly ref: number[] = [];
  private readonly seams = new Map<number, boolean>();
  /** Vertices inside a vertex patch (used by that patch's faces only). */
  private readonly inner = new Set<number>();

  constructor(
    private readonly m: MeshData,
    private readonly topo: Topology,
    private readonly b: MeshBuilder,
  ) {}

  /** Records new vertex `id` of original vertex `v` with its home (`ref`: the face or edge). */
  set(id: number, v: number, kind: HomeKind, ref = -1): void {
    this.vert[id] = v;
    this.kind[id] = kind;
    this.ref[id] = ref;
  }

  /** Gives `id` the home of vertex `from` (a profile point on the same side as its end `from`). */
  copy(id: number, from: number): void {
    this.set(id, this.vert[from], this.kind[from], this.ref[from]);
  }

  /** Records new vertex `id` of a vertex patch (see `set`) as inside the patch. */
  setInner(id: number, v: number, kind: HomeKind, ref = -1): void {
    this.set(id, v, kind, ref);
    this.inner.add(id);
  }

  homeFace(id: number): number {
    return this.kind[id] === HomeKind.FACE ? this.ref[id] : -1;
  }

  homeEdge(id: number): number {
    return this.kind[id] === HomeKind.EDGE ? this.ref[id] : -1;
  }

  /** Whether original edge e is a UV seam (its two faces disagree on the UV of an end). */
  seam(e: number): boolean {
    let r = this.seams.get(e);
    if (r !== undefined) return r;
    r = false;
    const fs = this.topo.edgeFaces[e];
    const uvs = this.m.uvs;
    if (fs.length === 2 && uvs) {
      const [f, g] = fs;
      for (const v of this.topo.edges[e]) {
        const i = this.m.faces[f].indexOf(v);
        const j = this.m.faces[g].indexOf(v);
        const du = uvs[f][i * 2] - uvs[g][j * 2];
        const dv = uvs[f][i * 2 + 1] - uvs[g][j * 2 + 1];
        if (Math.abs(du) > 1e-6 || Math.abs(dv) > 1e-6) r = true;
      }
    }
    this.seams.set(e, r);
    return r;
  }

  /** Whether any edge at original vertex v is a UV seam. */
  seamAt(v: number): boolean {
    return this.topo.vertEdges[v].some((e) => this.seam(e));
  }

  /** The edge of face f at its corner i that face g shares (−1 when none). */
  private sharedEdge(f: number, i: number, g: number): number {
    const L = this.m.faces[f].length;
    for (const e of [this.topo.faceEdges[f][(i + L - 1) % L], this.topo.faceEdges[f][i]])
      if (this.topo.edgeFaces[e].includes(g)) return e;
    return -1;
  }

  private isEdgeAt(f: number, i: number, e: number): boolean {
    const L = this.m.faces[f].length;
    return this.topo.faceEdges[f][i] === e || this.topo.faceEdges[f][(i + L - 1) % L] === e;
  }

  /** Whether face f can interpolate vertex id without snapping it into f. */
  compatible(f: number, id: number): boolean {
    const i = this.m.faces[f].indexOf(this.vert[id]);
    if (i < 0) return false;
    const k = this.kind[id];
    if (k === HomeKind.FACE) return this.ref[id] === f;
    if (k === HomeKind.EDGE) return this.isEdgeAt(f, i, this.ref[id]);
    return true;
  }

  /** Position `pt` snapped onto original edge e (the closest point of the segment). */
  private snap(e: number, pt: number[]): number[] {
    const P = this.m.positions;
    const [a, c] = this.topo.edges[e];
    const d = sub(P, c, a);
    const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    let t =
      dd > 0
        ? ((pt[0] - P[a * 3]) * d[0] + (pt[1] - P[a * 3 + 1]) * d[1] + (pt[2] - P[a * 3 + 2]) * d[2]) / dd
        : 0;
    t = Math.min(1, Math.max(0, t));
    return [P[a * 3] + d[0] * t, P[a * 3 + 1] + d[1] * t, P[a * 3 + 2] + d[2] * t];
  }

  /** UV of vertex id interpolated in original face f (`project`: f's UV at its position, no snapping). */
  uvIn(f: number, id: number, project = false): number[] {
    const v = this.vert[id];
    const face = this.m.faces[f];
    const i = face.indexOf(v);
    const P = this.m.positions;
    let pt = [this.b.positions[id * 3], this.b.positions[id * 3 + 1], this.b.positions[id * 3 + 2]];
    if (i < 0) return cornerUV(this.m, f, 0, pt);
    if (!project) {
      const k = this.kind[id];
      const at = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
      if (k === HomeKind.FACE && this.ref[id] !== f) {
        const e = this.sharedEdge(f, i, this.ref[id]);
        pt = e >= 0 ? this.snap(e, pt) : at;
      } else if (k === HomeKind.EDGE)
        pt = this.isEdgeAt(f, i, this.ref[id]) ? this.snap(this.ref[id], pt) : at;
      else if (k === HomeKind.VERT) pt = at;
    }
    return cornerUV(this.m, f, i, pt);
  }

  /**
   * The face among `faces` whose corner at vertex id's original vertex holds id's position best (the
   * largest smaller corner coordinate, in length units), or −1: when no face has that corner, or when
   * the UVs of that face's corner are degenerate (an extruded wall whose UVs collapse onto a line),
   * whose UV map cannot place a point off the line.
   */
  private holdingFace(id: number, faces: number[]): number {
    const v = this.vert[id];
    const pt = [this.b.positions[id * 3], this.b.positions[id * 3 + 1], this.b.positions[id * 3 + 2]];
    let best = -1;
    let bestScore = -Infinity;
    for (const f of faces) {
      const i = this.m.faces[f].indexOf(v);
      if (i < 0) continue;
      const { al, be, ab } = cornerCoords(this.m, f, i, pt);
      const score = Math.min(al * ab[0], be * ab[1]);
      if (score > bestScore) [best, bestScore] = [f, score];
    }
    if (best < 0) return -1;
    const uv = this.m.uvs![best];
    const L = this.m.faces[best].length;
    const i = this.m.faces[best].indexOf(v);
    const ip = (i + L - 1) % L;
    const inx = (i + 1) % L;
    const ax = uv[ip * 2] - uv[i * 2];
    const ay = uv[ip * 2 + 1] - uv[i * 2 + 1];
    const bx = uv[inx * 2] - uv[i * 2];
    const by = uv[inx * 2 + 1] - uv[i * 2 + 1];
    return Math.abs(ax * by - ay * bx) > 1e-3 * Math.hypot(ax, ay) * Math.hypot(bx, by) ? best : -1;
  }

  /**
   * Per-corner UVs of a new face with corners `loop` cut from the original faces `candidates` (in order
   * of preference); `continuous`: the UVs are continuous between those faces (no seam among them).
   */
  faceUVs(loop: number[], candidates: number[], continuous: boolean): number[] {
    // with continuous UVs a patch's inner vertices that lie over an edge or the vertex (sector boundaries,
    // the center) take the UV at their position in the face holding them, rather than snapping onto the
    // edge or the vertex: the same in every face of the patch, whose candidates are all the faces around
    // the vertex
    const own = new Map<number, number[]>();
    if (continuous)
      for (const x of loop)
        if (this.inner.has(x) && this.kind[x] !== HomeKind.FACE) {
          const f = this.holdingFace(x, candidates);
          if (f >= 0) own.set(x, this.uvIn(f, x, true));
        }
    const at = (f: number, x: number) => own.get(x) ?? this.uvIn(f, x);
    for (const f of candidates)
      if (loop.every((x) => this.compatible(f, x))) return loop.flatMap((x) => at(f, x));
    if (continuous)
      return loop.flatMap((x) => at(candidates.find((f) => this.compatible(f, x)) ?? candidates[0], x));
    let best = candidates[0];
    let bestN = -1;
    for (const f of candidates) {
      const n = loop.filter((x) => this.compatible(f, x)).length;
      if (n > bestN) [best, bestN] = [f, n];
    }
    return loop.flatMap((x) => this.uvIn(best, x));
  }
}

interface PatchCtx {
  b: MeshBuilder;
  uv: BevelUVs | null;
  /** The original faces around the patch's vertex (UV sources), and whether their UVs are seamless. */
  faces: number[];
  continuous: boolean;
  material: number;
  smooth: boolean;
}

/** Adds a face of a vertex patch. */
function addPatch(ctx: PatchCtx, loop: number[]): void {
  ctx.b.addFace(loop, ctx.material, ctx.smooth, ctx.uv?.faceUVs(loop, ctx.faces, ctx.continuous) ?? null);
}

/**
 * The quad-grid patch of `sides` (S ≥ 2 segments each, consecutive sides sharing their end points) at
 * original vertex v, or false when the sides do not close up that way (the caller adds a polygon).
 * `onVertex` gets every new vertex with its place in the grid (see `GridPatchContext`).
 */
function gridPatch(
  ctx: PatchCtx,
  sides: PatchSide[],
  S: number,
  profile: number,
  corner: number[],
  colors: ArrayLike<number> | null,
  v: number,
  onVertex: (id: number, i: number, j: number, k: number) => void,
): boolean {
  const n = sides.length;
  if (n < 3 || S < 2) return false;
  for (let i = 0; i < n; i++) if (sides[i].ids[S] !== sides[(i + 1) % n].ids[0]) return false;
  const gctx: GridPatchContext = {
    b: ctx.b,
    colors,
    colorIndex: v,
    profileAt: (a, b, c, t) => profilePoint(a, b, c, t, profile),
    onVertex,
    addFace: (loop) => addPatch(ctx, loop),
  };
  const k = profileExponent(profile);
  fillGridPatch(gctx, sides, S, corner, patchFullness(k), k > 2 ? 1 - 2 / k : 0);
  return true;
}

/** A profile side walked the other way. */
function reversedSide(s: PatchSide): PatchSide {
  return { ...s, ids: s.ids.slice().reverse(), a: s.b, b: s.a };
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
        // stop just short of the middle of the edge (like slides below): bevels from both ends that
        // met exactly would leave zero-area faces (e.g. the sides of a low-poly cylinder with NONE)
        if (projPrev > 1e-12) scaleLimit = Math.min(scaleLimit, (0.49 * lPrev) / projPrev);
        if (projNext > 1e-12) scaleLimit = Math.min(scaleLimit, (0.49 * lNext) / projNext);
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
  const uv = m.uvs ? new BevelUVs(m, topo, b) : null;
  for (let v = 0; v < nv; v++) {
    b.addVertex(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], colors, v);
    uv?.set(v, v, HomeKind.VERT);
  }
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
    uv?.set(idx, r.v, HomeKind.EDGE, r.e);
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
        uv?.set(idx, v, HomeKind.FACE, f);
      } else if (c?.kind === 'SLIDE') idx = slideVert.get(`${v}:${c.e}`)!;
      cornerVert.set(ck(f, i), idx);
      cornerUVs.set(ck(f, i), cornerUV(m, f, i, pos(idx)));
    }
  }
  const cornerOf = (f: number, v: number) => ck(f, m.faces[f].indexOf(v));

  // --- strips (with profile arcs at both ends)
  const arcs = new Map<string, number[]>(); // `${e}:${v}` → vertices from the first face side to the second
  const arcSpecs = new Map<string, { a: number[]; b: number[]; c: number[] }>(); // their profiles (segments > 1)
  const stripFace = (e: number): [number, number] => {
    const [a, c] = topo.edges[e];
    return [dirFace.get(`${a},${c}`) ?? -1, dirFace.get(`${c},${a}`) ?? -1];
  };
  /**
   * Whether beveled edge e is convex: corners of its second face lie below the first face's plane and
   * none above it (an edge between coplanar faces is not).
   */
  const convexEdge = (e: number): boolean => {
    const [fa, fb] = stripFace(e);
    const [a] = topo.edges[e];
    const tol = 1e-9 * edgeLen(e);
    let lowest = 0;
    let highest = 0;
    for (const x of m.faces[fb] ?? []) {
      const h =
        (P[x * 3] - P[a * 3]) * fn[fa * 3] +
        (P[x * 3 + 1] - P[a * 3 + 1]) * fn[fa * 3 + 1] +
        (P[x * 3 + 2] - P[a * 3 + 2]) * fn[fa * 3 + 2];
      lowest = Math.min(lowest, h);
      highest = Math.max(highest, h);
    }
    return lowest < -tol && highest <= tol;
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
      for (let j = 1; j < S; j++) {
        const q = profilePoint(pa, pb, C, j / S, p.profile);
        const idx = b.addVertex(q[0], q[1], q[2], colors, v);
        // each half of the profile lies in the strip's face on its side, also where its end is a slide
        // point: the profile leaves the slide edge at once (unless it is a weld's, below); the middle is
        // on e
        if (2 * j === S) uv?.set(idx, v, HomeKind.EDGE, e);
        else uv?.set(idx, v, HomeKind.FACE, 2 * j < S ? fa : fb);
        arc.push(idx);
      }
      arcSpecs.set(key, { a: pa, b: pb, c: C });
    }
    arc.push(B);
    arcs.set(key, arc);
    return arc;
  };

  // --- welds (Blender's two-edge weld): where exactly two beveled edges meet and each side between them
  // holds a single bevel vertex (a miter point inside a face, or one slide point on the only unbeveled edge
  // there, e.g. every rim vertex of a cylinder or a vertex in the middle of a beveled edge loop), both
  // strips end on the same two vertices. They share one profile chain bulging toward the original vertex
  // and need no vertex patch; a patch there would fill the sliver between two slightly different arcs.
  const welded = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) {
    const ring = rings[v];
    if (!ring) continue;
    const bev = ring.eIn.filter((e) => isB[e]);
    if (bev.length !== 2) continue;
    const ends = bev.map((e) => {
      const [fa, fb] = stripFace(e);
      return [cornerVert.get(cornerOf(fa, v))!, cornerVert.get(cornerOf(fb, v))!];
    });
    const [[a1, b1], [a2, b2]] = ends;
    if (a1 === b1 || !((a1 === a2 && b1 === b2) || (a1 === b2 && b1 === a2))) continue;
    welded[v] = 1;
    const arc = [a1];
    if (S > 1) {
      const pa = pos(a1);
      const pb = pos(b1);
      const C = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
      for (let j = 1; j < S; j++) {
        const q = profilePoint(pa, pb, C, j / S, p.profile);
        const idx = b.addVertex(q[0], q[1], q[2], colors, v);
        // the shared profile lies on both strips' middle lines at once: its middle is at v
        if (2 * j === S) uv?.set(idx, v, HomeKind.VERT);
        else uv?.copy(idx, 2 * j < S ? a1 : b1);
        arc.push(idx);
      }
    }
    arc.push(b1);
    arcs.set(`${bev[0]}:${v}`, arc);
    arcs.set(`${bev[1]}:${v}`, a2 === a1 ? arc : arc.slice().reverse());
  }

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
    const [fa, fb] = stripFace(e);
    const au = arcAt(e, u);
    const aw = arcAt(e, w);
    const mat = p.material >= 0 ? p.material : (m.faceMaterials[fa] ?? 0);
    const smooth = m.faceSmooth[fa] ?? false;
    // quads on one side of the middle take that face's UVs; the middle quad of an odd count spans both
    for (let j = 0; j < S; j++) {
      const quad = [aw[j], au[j], au[j + 1], aw[j + 1]];
      b.addFace(quad, mat, smooth, uv?.faceUVs(quad, [fa, fb], !uv.seam(e)) ?? null);
    }
  }

  // --- vertex patches
  for (let v = 0; v < nv; v++) {
    const ring = rings[v];
    if (!ring || welded[v] || !ring.eIn.some((e) => isB[e])) continue;
    const n = ring.faces.length;
    const seq: number[] = [];
    const push = (x: number) => {
      if (seq[seq.length - 1] !== x) seq.push(x);
    };
    const sides: PatchSide[] = []; // the profiles in fan order (the patch winds the other way)
    for (let k = 0; k < n; k++) {
      const e = ring.eIn[k];
      const fPrev = ring.faces[(k + n - 1) % n];
      if (isB[e]) {
        const arc = arcAt(e, v);
        const [fa] = stripFace(e);
        for (const x of fa === fPrev ? arc : arc.slice().reverse()) push(x);
        const spec = arcSpecs.get(`${e}:${v}`);
        if (spec) {
          const side = { ids: arc, ...spec, tag: e, dir: sub(P, other(e, v), v), convex: convexEdge(e) };
          sides.push(fa === fPrev ? side : reversedSide(side));
        }
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
      uv,
      faces: ring.faces,
      continuous: !uv?.seamAt(v),
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
              { verts: loop, uvs: uv ? loop.flatMap((x) => uv.uvIn(keepers[0], x, true)) : null },
            )
          : null;
        if (merged) {
          b.faces[fi] = merged.verts;
          if (b.uvs && merged.uvs) b.uvs[fi] = merged.uvs;
          continue;
        }
      }
      addPatch(ctx, loop);
      continue;
    }
    // three or more beveled edges, each pair of neighbours ending on one shared bevel vertex: quad grid
    const corner = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
    const gsides = sides.reverse().map(reversedSide);
    // UV homes of the grid vertices: sector i lies in the face at its corner (side i's first vertex);
    // with even S the sector boundaries run over the beveled edges and the center sits at v
    const half = S / 2;
    const sectorFace = (i: number): number => {
      const c = gsides[i].ids[0];
      const f = uv?.homeFace(c) ?? -1;
      if (f >= 0) return f;
      const es = uv?.homeEdge(c) ?? -1;
      const fs = es >= 0 ? topo.edgeFaces[es] : ring.faces;
      return fs.find((g) => topo.edgeFaces[gsides[i].tag!].includes(g)) ?? fs[0];
    };
    const onVertex = (id: number, i: number, j: number, k: number) => {
      if (!uv) return;
      if (i < 0) uv.setInner(id, v, HomeKind.VERT);
      else if (k === half) uv.setInner(id, v, HomeKind.EDGE, gsides[i].tag);
      else if (j === half)
        uv.setInner(id, v, HomeKind.EDGE, gsides[(i + gsides.length - 1) % gsides.length].tag);
      else uv.setInner(id, v, HomeKind.FACE, sectorFace(i));
    };
    if (gridPatch(ctx, gsides, S, p.profile, corner, colors, v, onVertex)) continue;
    addPatch(ctx, loop);
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
  const uv = m.uvs ? new BevelUVs(m, topo, b) : null;
  for (let v = 0; v < nv; v++) {
    b.addVertex(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], colors, v);
    uv?.set(v, v, HomeKind.VERT);
  }
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
      uv?.set(idx, v, HomeKind.EDGE, e);
      cut.set(key, idx);
    }
    return idx;
  };
  // per face corner: the arc from the cut on the incoming edge to the cut on the outgoing edge
  const cornerArc = new Map<string, number[]>();
  const cornerSpec = new Map<string, { a: number[]; b: number[]; c: number[] }>(); // its profile
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    const L = face.length;
    const loop: number[] = [];
    const luv: number[] = [];
    for (let i = 0; i < L; i++) {
      const v = face[i];
      if (!sel[v]) {
        loop.push(v);
        luv.push(...cornerUV(m, f, i, [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]));
        continue;
      }
      const eIn = topo.faceEdges[f][(i + L - 1) % L];
      const eOut = topo.faceEdges[f][i];
      const a = cutAt(v, eIn);
      const c = cutAt(v, eOut);
      const arc = [a];
      const pa = [b.positions[a * 3], b.positions[a * 3 + 1], b.positions[a * 3 + 2]];
      const pc = [b.positions[c * 3], b.positions[c * 3 + 1], b.positions[c * 3 + 2]];
      const pv = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
      for (let j = 1; j < S; j++) {
        const q = profilePoint(pa, pc, pv, j / S, p.profile);
        const idx = b.addVertex(q[0], q[1], q[2], colors, v);
        uv?.set(idx, v, HomeKind.FACE, f);
        arc.push(idx);
      }
      arc.push(c);
      cornerArc.set(`${f}:${i}`, arc);
      cornerSpec.set(`${f}:${i}`, { a: pa, b: pc, c: pv });
      for (const x of arc) {
        loop.push(x);
        luv.push(...cornerUV(m, f, i, [b.positions[x * 3], b.positions[x * 3 + 1], b.positions[x * 3 + 2]]));
      }
    }
    b.addFace(loop, m.faceMaterials[f] ?? 0, m.faceSmooth[f] ?? false, luv);
  }
  for (let v = 0; v < nv; v++) {
    if (!sel[v]) continue;
    const ring = rings[v]!;
    const seq: number[] = [];
    const sides: PatchSide[] = [];
    // walk the fan backwards so the patch is wound opposite to the face corners it borders
    for (let k = ring.faces.length - 1; k >= 0; k--) {
      const key = `${ring.faces[k]}:${ring.corners[k]}`;
      const arc = cornerArc.get(key)!;
      for (let j = arc.length - 1; j >= 0; j--) if (seq[seq.length - 1] !== arc[j]) seq.push(arc[j]);
      sides.push(reversedSide({ ids: arc, ...cornerSpec.get(key)!, tag: ring.faces[k] }));
    }
    while (seq.length > 1 && seq[0] === seq[seq.length - 1]) seq.pop();
    if (seq.length < 3) continue;
    const f0 = ring.faces[0];
    const ctx: PatchCtx = {
      b,
      uv,
      faces: ring.faces,
      continuous: !uv?.seamAt(v),
      material: p.material >= 0 ? p.material : (m.faceMaterials[f0] ?? 0),
      smooth: m.faceSmooth[f0] ?? false,
    };
    // UV homes of the grid vertices: side i lies in one face and sector i spans the corner between
    // side i − 1 and side i, which meet on an edge: the half nearer each side belongs to its face,
    // the diagonal from that corner to the center lies over the edge, the center at v
    const n = sides.length;
    const onVertex = (id: number, i: number, j: number, k: number) => {
      if (!uv) return;
      if (i < 0) uv.setInner(id, v, HomeKind.VERT);
      else if (j === k) uv.setInner(id, v, HomeKind.EDGE, uv.homeEdge(sides[i].ids[0]));
      else uv.setInner(id, v, HomeKind.FACE, sides[j < k ? i : (i + n - 1) % n].tag);
    };
    if (!gridPatch(ctx, sides, S, p.profile, [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]], colors, v, onVertex))
      addPatch(ctx, seq);
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
    'faces. Where two beveled edges meet (the rim of a cylinder with limit_method ANGLE) the strips continue into ' +
    'each other with one shared profile; where three or more meet (a cube corner, every rim vertex of a cylinder ' +
    'with limit_method NONE, whose vertical edges are beveled too) the corner is filled like Blender: with ' +
    'segments > 1 a grid of quads around a center vertex (even segments) or a center polygon (odd segments, e.g. ' +
    'one triangle per cube corner), round corners of round profiles lying on a sphere; with 1 segment one polygon. ' +
    'affect=VERTICES cuts off corners instead (rounded the same way with segments > 1). The width is clamped so ' +
    'neighbouring bevels stop just short of each other (use_clamp_overlap). Closed manifold input stays closed. ' +
    'UVs of the new faces are interpolated per face corner inside the UV island of the face each one was cut ' +
    'from (like Blender), so bevels do not stretch across UV seams. Limitations: boundary / non-manifold vertices ' +
    'are not beveled; with round profiles (about 0.4–0.7) and 4 or more segments, corner patches where edges of ' +
    'very different angles meet (every rim vertex of a cylinder with limit_method NONE) have shallow dents (under ' +
    '0.6% of the width).',
  schema,
  // MOD_bevel.cc is_disabled: `return (bmd->value == 0.0f);` (Blender's Amount, `width` here)
  disabled: (p) => (p.width === 0 ? 'has a width of 0' : null),
  apply(mesh, p) {
    return bevelMesh(mesh, p);
  },
};
