import type { CurveData, ModifierData } from '../doc/types';
import type { MeshData } from '../mesh/types';
import { roundBevelProfile, type BevelFillType } from '../curve/bevel';
import { glyphOutline } from '../curve/font';
import {
  getModifierDef,
  listModifierDefs,
  registerBuiltinModifiers,
  registerModifier,
  type ModifierDef,
} from '../modifiers';

/*
 * Memory estimates of modifier evaluations, and the check a host can run before each of them.
 *
 * The server evaluates scenes in its own process (scene summaries, mesh data, operators), next to
 * every editor connection, agent session and project room. When that process runs out of
 * JavaScript heap, V8 aborts it (a fatal error, not an exception), so one Subdivision Surface of a
 * few levels too many took the whole server down. The server therefore installs a check
 * (`setGeometryMemoryCheck`): every registered modifier is then wrapped so that, before it runs,
 * the check gets its estimated peak heap and may refuse it. A refused modifier throws, so it is
 * skipped and reported as that modifier's error wherever a modifier stack is evaluated (the
 * evaluator, Apply, orco and instancing), like a modifier that fails. Without a check (the browser,
 * the server's render processes, which run out of memory on their own) modifiers run as before.
 *
 * The estimates are what the evaluation of each modifier took at the peak of the JavaScript heap,
 * measured on grids of 62,500 to 1,000,000 faces (--trace-gc), per face of the input or of the
 * result, rounded up. Modifiers that grow the mesh are estimated from their parameters
 * (Subdivision Surface levels, Array count, Mirror axes, Screw steps, …); Array with FIT_LENGTH and
 * an object offset, Bevel with limit_method ANGLE and Boolean are approximations.
 */

/** Size of a mesh for the estimates. */
export interface MeshSize {
  faces: number;
  /** Face corners: the sum of the faces' vertex counts. */
  corners: number;
  vertices: number;
  /** Size of the bounding box (Array with FIT_LENGTH), when known. */
  extent?: readonly [number, number, number];
}

/** The size of `m` for {@link estimateModifier}. */
export function meshSize(m: MeshData, withExtent = false): MeshSize {
  let corners = 0;
  for (const f of m.faces) corners += f.length;
  const size: MeshSize = { faces: m.faces.length, corners, vertices: m.positions.length / 3 };
  if (withExtent && m.positions.length) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3)
      for (let k = 0; k < 3; k++) {
        if (p[i + k] < lo[k]) lo[k] = p[i + k];
        if (p[i + k] > hi[k]) hi[k] = p[i + k];
      }
    size.extent = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  }
  return size;
}

/** The estimated result of one modifier and the JavaScript heap its evaluation takes. */
export interface ModifierEstimate {
  /** Estimated size of the result. */
  result: MeshSize;
  /**
   * JavaScript heap the evaluation takes at its peak beyond its input (bytes): temporary
   * structures and the result. 0 when the modifier is not estimated (unknown type, invalid
   * parameters, or a result over the modifier's own limit, which it refuses by itself).
   */
  bytes: number;
  /** What to lower for a smaller result (for messages), e.g. "levels (render_levels for renders)". */
  lower: string;
  /**
   * The modifier fails by itself (invalid parameters, or a result over its own limit): its
   * evaluation reports an error instead of a result.
   */
  failsByItself?: boolean;
}

export interface EstimateContext {
  /** Render settings (SUBSURF render_levels, SCREW render_steps) instead of the viewport's. */
  forRender: boolean;
  /** Faces of another object's evaluated mesh (Boolean operands), when known. */
  operandFaces?: (objectId: string) => number | null;
  /**
   * A Bevel limited by angle bevels only the edges whose faces meet at more than its angle_limit,
   * which the counts of its input do not tell. With `bevelInput` (its input mesh itself) they are
   * counted ({@link bevelCount}); else with `bevelUpperBound` every edge is (limit_method NONE's
   * bound); else none is (a browser's estimate before its render, whose first worker counts them on
   * the real input before the Bevel runs: apps/web/src/render/guard.ts).
   */
  bevelInput?: MeshData | null;
  bevelUpperBound?: boolean;
}

/** Peak heap per face of the result (bytes), for modifiers that grow the mesh. */
export const MODIFIER_BYTES_PER_RESULT_FACE = {
  /** 583–675 measured (4,000,000 faces from a 125×125 grid at levels 4: 2.4 GB). */
  SUBSURF: 700,
  /** 347 measured. */
  ARRAY: 400,
  /** With use_mirror_merge (the default): 1069 measured on one axis, 1481 per estimated face on three. */
  MIRROR: 1500,
  /** Without merging: 412 measured. */
  MIRROR_NO_MERGE: 450,
  /** 998 measured. */
  SOLIDIFY: 1100,
  /** 555 measured (three faces per corner of the input). */
  WIREFRAME: 600,
  /** 490 measured. */
  TRIANGULATE: 550,
  /** Faces added by Bevel: 1670 measured (limit_method NONE, 2 segments). */
  BEVEL_ADDED: 1700,
  /** Faces swept by Screw (estimated from the profile's vertices). */
  SCREW: 700,
  /** Boolean: faces of both operands. */
  BOOLEAN: 4000,
} as const;

/** Peak heap per face of the input (bytes): every modifier copies its input, most build its topology. */
export const MODIFIER_BYTES_PER_INPUT_FACE: Readonly<Record<string, number>> = {
  /** 2.7 KB measured (topology and edge angles, nothing beveled on a flat grid). */
  BEVEL: 2800,
  /** 2.1 KB measured (a grid as the profile). */
  SCREW: 2200,
  /** COLLAPSE: more than 6.1 KB (still running after 10 minutes on 250,000 faces). */
  DECIMATE: 6500,
  /** 2.56 KB measured. */
  EDGE_SPLIT: 2600,
  /** 1.53 and 1.50 KB measured. */
  SMOOTH: 1600,
  SMOOTH_BY_ANGLE: 1600,
  /** 672 measured. */
  WELD: 700,
  /** 274–355 measured. */
  DISPLACE: 400,
  CAST: 400,
  SIMPLE_DEFORM: 400,
  WAVE: 400,
  /** Not measured: deforms that read weights or another object. */
  ARMATURE: 600,
  CURVE: 600,
  SHRINKWRAP: 600,
  /** 197 measured. */
  BUILD: 200,
};

/** Subdivision Surface refuses results over this many faces itself (subsurf.ts). */
const SUBSURF_MAX_FACES = 4_000_000;
/** Array refuses results over this many vertices itself (array.ts). */
const ARRAY_MAX_VERTICES = 5_000_000;

const same = (s: MeshSize): MeshSize => ({ faces: s.faces, corners: s.corners, vertices: s.vertices });
const elements = (s: MeshSize): number => Math.max(s.faces, s.vertices);
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/**
 * The estimated result size of modifier `mod` evaluated on a mesh of size `input`, and the peak
 * JavaScript heap of that evaluation (see the module comment). Modifiers are estimated with the
 * parameters they will run with (schema defaults filled in).
 */
export function estimateModifier(mod: ModifierData, input: MeshSize, ctx: EstimateContext): ModifierEstimate {
  registerBuiltinModifiers();
  const def = getModifierDef(mod.type);
  const parsed = def?.schema.safeParse(mod.params ?? {});
  if (!parsed?.success) return { result: same(input), bytes: 0, lower: '', failsByItself: true };
  return estimateParsed(mod.type, parsed.data as Record<string, unknown>, input, ctx);
}

/** {@link estimateModifier} with parameters already validated by the modifier's schema. */
function estimateParsed(
  type: string,
  p: Record<string, unknown>,
  input: MeshSize,
  ctx: EstimateContext,
): ModifierEstimate {
  const none: ModifierEstimate = { result: same(input), bytes: 0, lower: '' };
  const F = input.faces;
  const C = input.corners;
  const V = input.vertices;
  const perInput = (MODIFIER_BYTES_PER_INPUT_FACE[type] ?? 0) * Math.max(F, V);
  const K = MODIFIER_BYTES_PER_RESULT_FACE;
  switch (type) {
    case 'SUBSURF': {
      const levels = Math.round(num(ctx.forRender ? p.render_levels : p.levels, 0));
      if (levels <= 0 || V === 0) return none;
      const faces = C * 4 ** (levels - 1);
      if (faces > SUBSURF_MAX_FACES) return { ...none, failsByItself: true };
      const result = { faces, corners: 4 * faces, vertices: faces + V };
      return {
        result,
        bytes: K.SUBSURF * Math.max(faces, V * 2 ** levels),
        lower: ctx.forRender ? 'render_levels' : 'levels (render_levels for renders)',
      };
    }
    case 'ARRAY': {
      let count = Math.round(num(p.count, 2));
      if (p.fit_type === 'FIT_LENGTH') {
        const fit = num(p.fit_length, 0);
        const rel = (p.relative_offset_displace as number[] | undefined) ?? [1, 0, 0];
        const cst = (p.constant_offset_displace as number[] | undefined) ?? [1, 0, 0];
        if (p.use_object_offset || !input.extent) count = 10_000;
        else {
          const step = [0, 1, 2].map(
            (k) =>
              (p.use_relative_offset !== false ? rel[k] * input.extent![k] : 0) +
              (p.use_constant_offset ? cst[k] : 0),
          );
          const dist = Math.hypot(step[0], step[1], step[2]);
          count = dist > 1e-9 ? Math.floor(fit / dist + 1e-6) + 1 : 1;
        }
        count = Math.max(1, Math.min(10_000, count, Math.floor(ARRAY_MAX_VERTICES / Math.max(1, V))));
      }
      if (V === 0) return none;
      if (count * V > ARRAY_MAX_VERTICES) return { ...none, failsByItself: true };
      const result = { faces: F * count, corners: C * count, vertices: V * count };
      return { result, bytes: K.ARRAY * elements(result), lower: 'count' };
    }
    case 'MIRROR': {
      const axes = Array.isArray(p.use_axis) ? p.use_axis.filter(Boolean).length : 0;
      if (!axes || V === 0) return none;
      const n = 2 ** axes;
      const result = { faces: F * n, corners: C * n, vertices: V * n };
      const per = p.use_mirror_merge === false ? K.MIRROR_NO_MERGE : K.MIRROR;
      return { result, bytes: per * elements(result), lower: 'the mirror axes' };
    }
    case 'SCREW': {
      const steps = Math.round(num(ctx.forRender ? p.render_steps : p.steps, 16));
      const iterations = Math.round(num(p.iterations, 1));
      if (V === 0 || (num(p.angle, 1) === 0 && num(p.screw_offset, 0) === 0)) return none;
      const swept = V * steps * iterations;
      const result = { faces: swept, corners: 4 * swept, vertices: swept };
      return {
        result,
        bytes: perInput + K.SCREW * swept,
        lower: ctx.forRender
          ? 'render_steps or iterations'
          : 'steps (render_steps for renders) or iterations',
      };
    }
    case 'SOLIDIFY': {
      const rimOnly = !!p.use_rim_only;
      const result = rimOnly ? same(input) : { faces: 2 * F, corners: 2 * C, vertices: 2 * V };
      return { result, bytes: K.SOLIDIFY * Math.max(2 * F, V), lower: 'the faces of the mesh' };
    }
    case 'WIREFRAME': {
      const faces = 3 * C;
      const result = { faces, corners: 4 * faces, vertices: 2 * C };
      return { result, bytes: K.WIREFRAME * Math.max(faces, V), lower: 'the faces of the mesh' };
    }
    case 'TRIANGULATE': {
      const faces = Math.max(F, C - 2 * F);
      const result = { faces, corners: 3 * faces, vertices: V };
      return { result, bytes: K.TRIANGULATE * Math.max(faces, V), lower: 'the faces of the mesh' };
    }
    case 'BEVEL': {
      if (ctx.bevelInput) {
        // the edges and corners it bevels, counted on its input
        const c = bevelCount(ctx.bevelInput, p as unknown as BevelSizeParams);
        return {
          result: c.result,
          bytes: c.runs ? perInput + K.BEVEL_ADDED * c.added : 0,
          lower: 'segments',
        };
      }
      // limit_method NONE bevels every edge and every vertex: an upper bound from the counts alone
      // (bevelUpperBound: also for ANGLE); else ANGLE only sharp edges, not counted here
      if (p.limit_method !== 'NONE' && !ctx.bevelUpperBound)
        return { ...none, bytes: perInput, lower: 'segments' };
      const s = Math.max(1, Math.round(num(p.segments, 1)));
      const b = bevelBound(input, s);
      return { result: b.result, bytes: perInput + K.BEVEL_ADDED * b.added, lower: 'segments' };
    }
    case 'BOOLEAN': {
      const other = typeof p.object === 'string' ? (ctx.operandFaces?.(p.object) ?? 0) : 0;
      if (!p.object) return none;
      const result = { faces: F + other, corners: C + 4 * other, vertices: V + other };
      return { result, bytes: K.BOOLEAN * (F + other), lower: 'the faces of both meshes' };
    }
    default:
      return { result: same(input), bytes: perInput, lower: 'the faces of the mesh' };
  }
}

/** The parameters of the Bevel modifier that decide its size (as its schema fills them in). */
export interface BevelSizeParams {
  width: number;
  segments: number;
  limit_method: string;
  angle_limit: number;
  affect: string;
}

/** What the Bevel modifier makes of a mesh, counted without beveling it ({@link bevelCount}). */
export interface BevelCount {
  /** Size of the result, an upper bound. */
  result: MeshSize;
  /** Faces it adds. */
  added: number;
  /** Edges it bevels (affect EDGES). */
  edges: number;
  /** Vertices it gives a patch. */
  patched: number;
  /** Whether it runs at all (a width above 0 and faces to bevel): it builds the topology of its input. */
  runs: boolean;
}

/**
 * The size of what the Bevel modifier (modifiers/bevel.ts) makes of `mesh`, counted from the edges
 * and corners it bevels without beveling them, in typed arrays: an edge between two faces
 * (limit_method NONE, or ANGLE when its faces meet at more than angle_limit) gets a strip of
 * `segments` faces; a corner where such edges meet gets a patch (three or more edges and two or more
 * segments: a quad grid of ⌊segments / 2⌋ × ⌈segments / 2⌉ faces per edge, one more in the middle
 * when the segments are odd; else one polygon). With affect VERTICES every corner with such an edge
 * gets the patch of its faces. An upper bound: Bevel bevels only edges whose ends have a closed fan
 * of faces, and merges or welds some patches. Browser render workers size their check of a Bevel
 * with it (apps/web/src/render/guard.ts), the server its check before the Bevel runs.
 */
export function bevelCount(mesh: MeshData, p: BevelSizeParams): BevelCount {
  const faces = mesh.faces;
  const F = faces.length;
  const V = Math.floor(mesh.positions.length / 3);
  let C = 0;
  for (const f of faces) C += f.length;
  const input: MeshSize = { faces: F, corners: C, vertices: V };
  if (!(p.width > 0) || F === 0) return { result: input, added: 0, edges: 0, patched: 0, runs: false };
  const S = Math.max(1, Math.round(p.segments));
  const angle = p.limit_method !== 'NONE';
  // the corners of each vertex by the vertex after them in their face: one number per corner, the
  // next vertex × C + the corner (its place in all faces' corners, faceStart[face] + its place in the
  // face), sorted per vertex. The faces of an edge (a, b) are then found by binary searches among the
  // corners of a and of b, not a scan of every corner of a for every edge, which took O(valence²) at
  // the centre of a fan (20 s for two cones of 20,000 triangles around one vertex each)
  if ((V + 1) * C > Number.MAX_SAFE_INTEGER) {
    // too many to number (no mesh in a JavaScript heap is that large): every edge beveled
    const b = bevelBound(input, S);
    return { result: b.result, added: b.added, edges: 0, patched: 0, runs: true };
  }
  const faceStart = new Int32Array(F + 1);
  const faceOf = new Int32Array(C);
  for (let f = 0, k = 0; f < F; f++) {
    for (let i = faces[f].length; i > 0; i--) faceOf[k++] = f;
    faceStart[f + 1] = k;
  }
  const start = new Int32Array(V + 1);
  for (const f of faces) for (const v of f) if (v >= 0 && v < V) start[v + 1]++;
  for (let v = 0; v < V; v++) start[v + 1] += start[v];
  const next = start.slice(0, V);
  const after = new Float64Array(start[V]);
  for (let f = 0; f < F; f++) {
    const face = faces[f];
    for (let i = 0; i < face.length; i++) {
      const v = face[i];
      if (v < 0 || v >= V) continue;
      after[next[v]++] = face[(i + 1) % face.length] * C + faceStart[f] + i;
    }
  }
  for (let v = 0; v < V; v++) {
    const s = start[v];
    const e = start[v + 1];
    if (e - s > 16) {
      after.subarray(s, e).sort();
      continue;
    }
    // few corners: insertion sort, without a typed array view per vertex
    for (let i = s + 1; i < e; i++) {
      const x = after[i];
      let j = i - 1;
      while (j >= s && after[j] > x) {
        after[j + 1] = after[j];
        j--;
      }
      after[j + 1] = x;
    }
  }
  /** The first corner of `v` (in `after`) whose key is `x` or more. */
  const firstAtLeast = (v: number, x: number): number => {
    let i = start[v];
    let j = start[v + 1];
    if (j - i <= 16) {
      while (i < j && after[i] < x) i++;
      return i;
    }
    while (i < j) {
      const mid = (i + j) >>> 1;
      if (after[mid] < x) i = mid + 1;
      else j = mid;
    }
    return i;
  };
  // unit face normals (Newell, as the Bevel modifier computes them; zero for degenerate faces)
  const normals = angle ? new Float64Array(3 * F) : null;
  if (normals) {
    const P = mesh.positions;
    for (let f = 0; f < F; f++) {
      const face = faces[f];
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let i = 0; i < face.length; i++) {
        const a = face[i] * 3;
        const b = face[(i + 1) % face.length] * 3;
        nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
        ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
        nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
      }
      const l = Math.hypot(nx, ny, nz);
      if (l > 1e-30) {
        normals[f * 3] = nx / l;
        normals[f * 3 + 1] = ny / l;
        normals[f * 3 + 2] = nz / l;
      }
    }
  }
  const cosLimit = Math.cos(p.angle_limit);
  let users = 0;
  let first = 0;
  let other = -1;
  /**
   * The faces of edge (a, b) of face f, as the corners of a next to b in their face, each counted
   * once: those followed by b, and those after a corner of b that are not followed by b too. Sets
   * `users` (how many; counting stops at 3, enough to tell that the edge has more than two), and
   * with two of them `first` (the face of lowest index) and `other` (the face that is not f).
   */
  const edgeFaces = (f: number, a: number, b: number) => {
    users = 0;
    first = f;
    other = -1;
    const keyB = b * C;
    const i0 = firstAtLeast(a, keyB);
    let i1 = i0;
    for (const e = start[a + 1], hi = keyB + C; i1 < e && after[i1] < hi; i1++) {
      const g = faceOf[after[i1] - keyB];
      if (++users > 2) return;
      if (g < first) first = g;
      if (g !== f) other = g;
    }
    const keyA = a * C;
    for (let j = firstAtLeast(b, keyA), e = start[b + 1], hi = keyA + C; j < e && after[j] < hi; j++) {
      // the corner of a after this corner of b
      const kb = after[j] - keyA;
      const fb = faceOf[kb];
      const ka = kb + 1 < faceStart[fb + 1] ? kb + 1 : faceStart[fb];
      let counted = false;
      for (let i = i0; i < i1 && !counted; i++) counted = after[i] === keyB + ka;
      if (counted) continue;
      if (++users > 2) return;
      if (fb < first) first = fb;
      if (fb !== f) other = fb;
    }
  };
  // the Bevel modifier bevels only around vertices with a closed fan of faces: not at an edge with
  // one face or more than two (open borders, non-manifold parts)
  const fan = new Uint8Array(V).fill(1);
  for (let f = 0; f < F; f++) {
    const face = faces[f];
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      if (a < 0 || a >= V || b < 0 || b >= V) continue;
      if (a === b) fan[a] = 0;
      else {
        edgeFaces(f, a, b);
        if (users !== 2) fan[a] = fan[b] = 0;
      }
    }
  }
  // beveled edges per vertex; each edge is counted from the first face that has it
  const beveled = new Int32Array(V);
  let edges = 0;
  for (let f = 0; f < F; f++) {
    const face = faces[f];
    const L = face.length;
    for (let i = 0; i < L; i++) {
      const a = face[i];
      const b = face[(i + 1) % L];
      if (a === b || a < 0 || a >= V || b < 0 || b >= V || !fan[a] || !fan[b]) continue;
      edgeFaces(f, a, b);
      if (users !== 2 || first !== f) continue;
      if (normals && other >= 0) {
        const dot =
          normals[f * 3] * normals[other * 3] +
          normals[f * 3 + 1] * normals[other * 3 + 1] +
          normals[f * 3 + 2] * normals[other * 3 + 2];
        // the modifier: sharper than the limit (minus 1e-9); counted generously here
        if (!(dot < cosLimit + 1e-9)) continue;
      }
      edges++;
      beveled[a]++;
      beveled[b]++;
    }
  }
  const half = Math.floor(S / 2);
  const odd = S % 2;
  let added = 0;
  // corners of the new faces, and the corners the faces around beveled corners gain
  let corners = 0;
  let selected = 0;
  /**
   * The patch where n profiles meet at a vertex: a quad grid, else one polygon of `polygon` corners
   * (the profiles' points, and the points on the edges between them).
   */
  const patch = (n: number, polygon: number) => {
    if (n >= 3 && S >= 2) {
      const quads = n * half * (half + odd);
      added += quads + odd;
      corners += 4 * quads + odd * n;
    } else {
      added++;
      corners += polygon;
    }
  };
  // vertices that get a patch
  let patched = 0;
  if (p.affect === 'VERTICES') {
    for (let v = 0; v < V; v++) {
      const valence = start[v + 1] - start[v];
      if (!valence || !fan[v] || (angle && !beveled[v])) continue;
      patch(valence, S * valence);
      patched++;
      // each corner of the vertex becomes an arc of S + 1 points in its face
      corners += S * valence;
      selected += valence;
    }
  } else if (edges) {
    added += S * edges;
    corners += 4 * S * edges;
    for (let v = 0; v < V; v++) {
      const k = beveled[v];
      if (!k) continue;
      const valence = start[v + 1] - start[v];
      patch(k, S * k + 2 * (valence - k));
      patched++;
      // the edges next to a beveled one get a slide point, in the loops of both their faces
      corners += 2 * Math.min(2 * k, valence - k);
    }
  }
  if (!added) return { result: input, added: 0, edges, patched, runs: true };
  return {
    result: { faces: F + added, corners: C + corners, vertices: V + C + added + S * selected },
    added,
    edges: p.affect === 'VERTICES' ? 0 : edges,
    patched,
    runs: true,
  };
}

/**
 * What the Bevel modifier makes of a mesh of `input`'s size with every edge and corner beveled
 * (limit_method NONE), at most, in `s` segments: a strip of s faces per edge (at most corners / 2
 * edges have two faces), a patch per corner of at most ⌊s/2⌋ × ⌈s/2⌉ faces per edge it joins (each
 * edge joins two: corners in all) and one more face. The corners and vertices bound those
 * {@link bevelCount} counts.
 */
function bevelBound(input: MeshSize, s: number): { result: MeshSize; added: number } {
  const C = input.corners;
  const V = input.vertices;
  const added = Math.round((C / 2) * s + C * Math.floor(s / 2) * Math.ceil(s / 2) + V);
  return {
    added,
    result: {
      faces: input.faces + added,
      corners: C + 4 * added + (s + 4) * C,
      vertices: V + C + added + s * C,
    },
  };
}

/**
 * Peak heap the surface of a text object takes per character with a glyph (bytes), filled flat with
 * the default resolution: 54,800–61,700 measured (texts of 4,909 to 16,363 glyphs of the built-in
 * font, 'The quick brown fox jumps over the lazy dog 0123456789' repeated; 44,000 for 20,000 glyphs
 * of a plainer text), rounded up. Server checks count text surfaces from their glyph outlines
 * ({@link estimateCurveSurface}), at least at this cost.
 */
export const TEXT_BYTES_PER_CHARACTER = 64_000;
/** Faces of a text surface per character (28.5 measured, rounded up). */
export const TEXT_FACES_PER_CHARACTER = 30;

/** Characters of a text body that have a glyph (whitespace has none). */
export function textGlyphCount(body: string): number {
  let n = 0;
  for (const ch of body) if (!/\s/.test(ch)) n++;
  return n;
}

/**
 * Young-generation garbage of building a curve or text surface (bytes), part of every peak measured
 * with --trace-gc, like core operators/memory.ts OPERATOR_FIXED_BYTES.
 */
export const CURVE_FIXED_BYTES = 32 * 1024 * 1024;
/**
 * Peak heap per point the splines (or glyph outlines) of a curve or text are sampled into, beyond
 * {@link CURVE_FIXED_BYTES} (bytes): the samples, their frames, the wire built from them (860–870
 * measured on wires of 100,000 and 250,000 samples) or a flat 2D fill of them (690–780 with the fill,
 * text of 2,000 and 5,000 characters and a circle of 64,000 points), rounded up.
 */
export const CURVE_BYTES_PER_SAMPLE = 1000;
/**
 * Peak heap per vertex of the surface swept along a curve or a text (bevel, extrusion) and of the
 * fills of 2D curves and text, beyond the samples (bytes): 260–300 measured on smooth sweeps of
 * 0.8 to 2.9 million vertices (round and object bevels, extruded 2D fills, beveled text), 406–463
 * where every sample is a sharp corner (sharp edges are stored per edge); rounded up.
 */
export const CURVE_BYTES_PER_VERTEX = 520;

/** Most points a spline is sampled into (curve/spline.ts MAX_SAMPLES_PER_SPLINE). */
const MAX_SPLINE_SAMPLES = 250_000;
/** Largest surface swept along a curve (vertices, curve/to-mesh.ts MAX_VERTICES); denser ones are not swept. */
const CURVE_MAX_SWEEP_VERTICES = 3_000_000;

/**
 * Points a spline of `curve` is sampled into, at most: what curve/spline.ts evaluateSpline makes of
 * its points and resolution (POLY splines keep their points; Bezier and NURBS splines take
 * `resolution` points per segment, at most MAX_SPLINE_SAMPLES).
 */
function splineSamples(curve: CurveData, raw: unknown, forRender: boolean): number {
  const s = (raw && typeof raw === 'object' ? raw : {}) as {
    type?: unknown;
    points?: unknown;
    resolution_u?: unknown;
  };
  const n = Array.isArray(s.points) ? s.points.length : 0;
  if (n <= 1 || s.type === 'POLY') return n;
  const own = Math.max(0, Math.min(1024, Math.round(num(s.resolution_u, 0))));
  const base =
    forRender && num(curve.render_resolution_u, 0) > 0 ? curve.render_resolution_u : curve.resolution_u;
  const r = own > 0 ? own : base;
  let res = Math.max(1, Math.min(1024, Math.round(Number.isFinite(r) ? r : 12)));
  if (n * res > MAX_SPLINE_SAMPLES) res = Math.max(1, Math.floor(MAX_SPLINE_SAMPLES / n));
  return n * res + 1;
}

/** The estimated surface of a curve or text, and the heap building it takes. */
export interface CurveSurfaceEstimate {
  /** Points of the sampled splines or glyph outlines (contours). */
  samples: number;
  /** Size of the surface (all 0 when the curve gets only a wire). */
  result: MeshSize;
  /** Peak heap of building it (bytes). */
  bytes: number;
  /** What to lower for a smaller surface, completing "Lower …". */
  lower: string;
}

/**
 * The surface curve/to-mesh.ts curveToMesh builds for `curve` (a CURVE object's data, or a FONT
 * object's with `isText`), estimated from its splines or glyphs and its settings without building
 * anything: every spline (or glyph outline) is swept with the bevel profile (ROUND: bevel_depth and
 * bevel_resolution; OBJECT: the sampled splines of `bevelCurve`, the bevel object's curve) or the
 * extrusion, and 2D curves and text fill their closed outlines (front and back when swept). An upper
 * bound: every sampled point counted, two more per contour for bevel factors, fills counted as many
 * triangles as outline points.
 */
export function estimateCurveSurface(
  curve: CurveData,
  opts: { isText: boolean; forRender: boolean; bevelCurve?: CurveData | null },
): CurveSurfaceEstimate {
  // the viewport's advice names both settings, like Subdivision Surface's: get_scene lists a
  // surface both evaluations skip once, with the viewport's message
  const renderResolution = num(curve.render_resolution_u, 0) > 0;
  const resolutionName = !renderResolution
    ? 'resolution_u'
    : opts.forRender
      ? 'render_resolution_u'
      : 'resolution_u (render_resolution_u for renders)';
  // contours: the glyph outlines of a text, the sampled splines of a curve
  let points = 0;
  let contours = 0;
  if (opts.isText) {
    const res =
      opts.forRender && curve.render_resolution_u > 0 ? curve.render_resolution_u : curve.resolution_u;
    const seg = Math.max(2, Math.min(64, Math.round(num(res, 12))));
    const perGlyph = new Map<string, [number, number]>();
    for (const ch of typeof curve.body === 'string' ? curve.body : '') {
      // laid-out characters with a glyph (curve/text.ts: control characters dropped, spaces empty)
      if (ch < ' ' || ch === ' ' || ch === ' ') continue;
      let g = perGlyph.get(ch);
      if (!g) {
        const outline = glyphOutline(ch, seg).contours;
        g = [outline.reduce((a, c) => a + c.length, 0), outline.length];
        perGlyph.set(ch, g);
      }
      points += g[0];
      contours += g[1];
    }
  } else {
    for (const s of Array.isArray(curve.splines) ? curve.splines : []) {
      points += splineSamples(curve, s, opts.forRender);
      contours++;
    }
  }
  // the profile (curve/to-mesh.ts readSettings and buildCurveMesh)
  const is2D = opts.isText || curve.dimensions === '2D';
  const mode = curve.fill_mode;
  const fill2D = mode === 'NONE' ? 'NONE' : mode === 'FRONT' ? 'FRONT' : mode === 'BACK' ? 'BACK' : 'BOTH';
  const bevelFill: BevelFillType = is2D
    ? fill2D === 'NONE'
      ? 'FULL'
      : fill2D === 'BOTH'
        ? 'HALF'
        : fill2D
    : mode === 'HALF' || mode === 'BOTH'
      ? 'HALF'
      : mode === 'FRONT'
        ? 'FRONT'
        : mode === 'BACK'
          ? 'BACK'
          : 'FULL';
  const depth = Math.max(0, num(curve.bevel_depth, 0));
  const extrude = Math.max(0, num(curve.extrude, 0));
  let profile = 0;
  let profiles = 0;
  let profileName = '';
  if (curve.bevel_mode === 'OBJECT') {
    if (curve.bevel_object && opts.bevelCurve) {
      for (const s of Array.isArray(opts.bevelCurve.splines) ? opts.bevelCurve.splines : []) {
        profile += splineSamples(opts.bevelCurve, s, opts.forRender);
        profiles++;
      }
      profileName = "the bevel object's resolution_u";
    }
  } else if (depth > 0) {
    const resolution = Math.max(0, Math.min(32, Math.round(num(curve.bevel_resolution, 4))));
    profile = roundBevelProfile(depth, extrude, resolution, bevelFill)?.points.length ?? 0;
    profiles = profile ? 1 : 0;
    profileName = 'bevel_resolution';
  } else if (extrude > 0) {
    profile = 2;
    profiles = 1;
  }
  const along = points + 2 * contours;
  // swept surface: one ring of profile points per sample (none over the sweep limit)
  const swept = profile ? Math.min(points * profile, CURVE_MAX_SWEEP_VERTICES) + 2 * contours * profile : 0;
  // 2D fills: the closed outlines on the front and back of a swept profile, else once (flat)
  const filled = is2D && fill2D !== 'NONE' ? (profile ? 2 : 1) * along : 0;
  // end caps of open sweeps
  const caps = curve.use_fill_caps ? 2 * contours * profiles : 0;
  const result: MeshSize = {
    vertices: swept + filled,
    faces: swept + filled + caps,
    corners: 4 * swept + 3 * filled + (curve.use_fill_caps ? 2 * contours * profile : 0),
  };
  const lower = [
    opts.isText ? 'the length of the text' : '',
    resolutionName,
    profileName,
    opts.isText ? '' : 'the number of spline points',
  ].filter(Boolean);
  return {
    samples: points,
    result,
    bytes: CURVE_FIXED_BYTES + CURVE_BYTES_PER_SAMPLE * along + CURVE_BYTES_PER_VERTEX * (swept + filled),
    lower: lower.length > 1 ? `${lower.slice(0, -1).join(', ')} or ${lower[lower.length - 1]}` : lower[0],
  };
}

/**
 * Why the surface of curve or text object `o` is not built (null: build it): asks the installed
 * check with its estimate ({@link estimateCurveSurface}; for text at least the measured cost per
 * character, {@link TEXT_BYTES_PER_CHARACTER}). `bevelCurve`: the curve of its bevel object
 * (bevel_mode OBJECT). Nothing to do without a check.
 */
export function curveMemoryRefusal(
  o: { type: string },
  curve: CurveData,
  opts: { forRender: boolean; bevelCurve?: CurveData | null },
): string | null {
  const check = installed;
  if (!check || (o.type !== 'CURVE' && o.type !== 'FONT')) return null;
  const isText = o.type === 'FONT';
  const e = estimateCurveSurface(curve, { isText, forRender: opts.forRender, bevelCurve: opts.bevelCurve });
  const bytes = Math.max(e.bytes, isText ? textGlyphCount(curve.body ?? '') * TEXT_BYTES_PER_CHARACTER : 0);
  if (!bytes) return null;
  const reason = check({
    type: isText ? 'TEXT' : 'CURVE',
    label: isText ? 'text surface' : 'curve surface',
    estimate: { result: e.result, bytes, lower: e.lower },
  });
  if (reason) refused(reason);
  return reason;
}

/** What a {@link GeometryMemoryCheck} is asked before a modifier runs. */
export interface GeometryMemoryRequest {
  /** Modifier type, e.g. "SUBSURF". */
  type: string;
  /** Modifier type label, e.g. "Subdivision Surface". */
  label: string;
  estimate: ModifierEstimate;
}

/** Returns null to run the modifier, or why it is skipped (it then fails with that message). */
export type GeometryMemoryCheck = (req: GeometryMemoryRequest) => string | null;

let installed: GeometryMemoryCheck | null = null;
let refusals = 0;
/** The last refusals' messages, numbered like `refusals` (see {@link geometryMemoryRefusalsSince}). */
const recent: { n: number; message: string }[] = [];

/** Counts a refusal and keeps its message. */
function refused(message: string): void {
  refusals++;
  recent.push({ n: refusals, message });
  if (recent.length > 32) recent.shift();
}
/** The registered modifiers as they were before they were wrapped, by type. */
const unwrapped = new Map<string, ModifierDef>();

/** `def` with the installed check before it runs (see the module comment). */
function guarded(def: ModifierDef): ModifierDef {
  return {
    ...def,
    apply(mesh, params, ctx) {
      const check = installed;
      if (check) {
        const estimate = estimateParsed(
          def.type,
          params as Record<string, unknown>,
          meshSize(mesh, def.type === 'ARRAY'),
          {
            forRender: ctx.forRender,
            operandFaces: (id) => ctx.getObjectMesh(id)?.mesh.faces.length ?? null,
            // a Bevel by angle: the edges it bevels, counted on its input
            bevelInput: def.type === 'BEVEL' ? mesh : null,
          },
        );
        const reason = estimate.bytes > 0 ? check({ type: def.type, label: def.label, estimate }) : null;
        if (reason) {
          refused(reason);
          throw new Error(reason);
        }
      }
      return def.apply(mesh, params, ctx);
    },
  };
}

/**
 * Installs the check every modifier runs before it (null removes it and restores the modifiers).
 * Returns the check that was installed before.
 */
export function setGeometryMemoryCheck(check: GeometryMemoryCheck | null): GeometryMemoryCheck | null {
  const before = installed;
  installed = check;
  registerBuiltinModifiers();
  if (check) {
    for (const def of listModifierDefs()) {
      if (unwrapped.has(def.type)) continue;
      unwrapped.set(def.type, def);
      registerModifier(guarded(def));
    }
  } else {
    for (const def of unwrapped.values()) registerModifier(def);
    unwrapped.clear();
  }
  return before;
}

/** The installed check, if any. */
export function geometryMemoryCheck(): GeometryMemoryCheck | null {
  return installed;
}

/** Modifiers the installed checks refused so far (a result with one of them is not cached). */
export function geometryMemoryRefusals(): number {
  return refusals;
}

/** Messages of the refusals after the first `count` (the last 32 at most). */
export function geometryMemoryRefusalsSince(count: number): string[] {
  return recent.filter((r) => r.n > count).map((r) => r.message);
}
