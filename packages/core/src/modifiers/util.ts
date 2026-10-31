import { z } from 'zod';
import type { Mat4, Vec3 } from '../math/types';
import { invert4, multiply4 } from '../math/mat4';
import type { EdgeAttr, MeshData } from '../mesh/types';
import { edgeKey, parseEdgeKey, vertexCount } from '../mesh/types';
import type { ModifierContext } from './registry';

/*
 * Shared helpers for modifier implementations: parameter schema shorthands, a small mesh builder,
 * explicit vertex merging, spatial hashing, normals and helper-object transforms.
 */

export const DEG = Math.PI / 180;

// ------------------------------------------------------------------ schema helpers

export const zVec3 = (def: Vec3) =>
  z
    .tuple([z.number(), z.number(), z.number()])
    .default(() => [def[0], def[1], def[2]] as [number, number, number]);

export const zBool3 = (def: [boolean, boolean, boolean]) =>
  z
    .tuple([z.boolean(), z.boolean(), z.boolean()])
    .default(() => [def[0], def[1], def[2]] as [boolean, boolean, boolean]);

/** Reference to another object (by id); null when unset. */
export const zObjectRef = (description: string) => z.string().nullable().default(null).describe(description);

export const zAxis = (def: 'X' | 'Y' | 'Z') => z.enum(['X', 'Y', 'Z']).default(def);

export function axisIndex(a: 'X' | 'Y' | 'Z'): 0 | 1 | 2 {
  return a === 'X' ? 0 : a === 'Y' ? 1 : 2;
}

// ------------------------------------------------------------------ attribute helpers

export function hasColors(m: MeshData): boolean {
  return !!m.colors && m.colors.length === vertexCount(m) * 4;
}

/** Returns a copy of `a` without default values, or null when nothing remains. */
export function cleanEdgeAttr(a: EdgeAttr | undefined | null): EdgeAttr | null {
  if (!a) return null;
  const out: EdgeAttr = {};
  if (a.seam) out.seam = true;
  if (a.sharp) out.sharp = true;
  if (a.crease && a.crease > 0) out.crease = Math.min(1, a.crease);
  return out.seam || out.sharp || out.crease ? out : null;
}

export function mergeEdgeAttr(a: EdgeAttr | undefined, b: EdgeAttr): EdgeAttr {
  if (!a) return { ...b };
  const out: EdgeAttr = { ...a };
  if (b.seam) out.seam = true;
  if (b.sharp) out.sharp = true;
  if (b.crease !== undefined) out.crease = Math.max(out.crease ?? 0, b.crease);
  return out;
}

/** Corner UVs of a face reversed together with a reversed vertex loop. */
export function reverseUVPairs(uv: number[]): number[] {
  const out = new Array<number>(uv.length);
  const n = uv.length / 2;
  for (let i = 0; i < n; i++) {
    out[i * 2] = uv[(n - 1 - i) * 2];
    out[i * 2 + 1] = uv[(n - 1 - i) * 2 + 1];
  }
  return out;
}

/** Shallow copy of a mesh with new positions (topology arrays are shared; treat results as immutable). */
export function withPositions(m: MeshData, positions: number[]): MeshData {
  return { ...m, positions };
}

// ------------------------------------------------------------------ mesh builder

/** Incrementally builds a MeshData (optionally with per-vertex colors and per-corner UVs). */
export class MeshBuilder {
  positions: number[] = [];
  colors: number[] | null;
  faces: number[][] = [];
  faceMaterials: number[] = [];
  faceSmooth: boolean[] = [];
  uvs: number[][] | null;
  edgeAttrs: Record<string, EdgeAttr> = {};
  looseEdges: number[] = [];

  constructor(opts: { colors?: boolean; uvs?: boolean } = {}) {
    this.colors = opts.colors ? [] : null;
    this.uvs = opts.uvs ? [] : null;
  }

  /** Builder with the same optional layers as `m`. */
  static like(m: MeshData): MeshBuilder {
    return new MeshBuilder({ colors: hasColors(m), uvs: !!m.uvs });
  }

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  /** Adds a vertex; its color is copied from `colorSrc[colorIndex]` (RGBA) when colors are stored. */
  addVertex(x: number, y: number, z: number, colorSrc?: ArrayLike<number> | null, colorIndex = 0): number {
    const i = this.positions.length / 3;
    this.positions.push(x, y, z);
    if (this.colors) {
      if (colorSrc && colorSrc.length >= colorIndex * 4 + 4) {
        const o = colorIndex * 4;
        this.colors.push(colorSrc[o], colorSrc[o + 1], colorSrc[o + 2], colorSrc[o + 3]);
      } else this.colors.push(1, 1, 1, 1);
    }
    return i;
  }

  /** Adds a vertex with an explicit RGBA color. */
  addVertexRGBA(x: number, y: number, z: number, rgba: ArrayLike<number> | null): number {
    return this.addVertex(x, y, z, rgba, 0);
  }

  addFace(verts: number[], material = 0, smooth = false, uv?: number[] | null): number {
    this.faces.push(verts);
    this.faceMaterials.push(material);
    this.faceSmooth.push(smooth);
    if (this.uvs)
      this.uvs.push(uv && uv.length === verts.length * 2 ? uv : new Array(verts.length * 2).fill(0));
    return this.faces.length - 1;
  }

  addLooseEdge(a: number, b: number): void {
    if (a !== b) this.looseEdges.push(a, b);
  }

  setEdgeAttr(a: number, b: number, attr: EdgeAttr | undefined | null): void {
    const c = cleanEdgeAttr(attr);
    if (!c || a === b) return;
    const k = edgeKey(a, b);
    this.edgeAttrs[k] = mergeEdgeAttr(this.edgeAttrs[k], c);
  }

  build(): MeshData {
    return {
      positions: this.positions,
      faces: this.faces,
      faceMaterials: this.faceMaterials,
      faceSmooth: this.faceSmooth,
      uvs: this.uvs,
      colors: this.colors,
      edgeAttrs: this.edgeAttrs,
      looseEdges: this.looseEdges,
    };
  }
}

// ------------------------------------------------------------------ vertex merging

/**
 * Merges vertices following an explicit map: `target[i]` is the vertex that `i` merges into (chains are
 * followed). Representatives keep their position (or the one given in `positions`). Collapsed corners are
 * removed from faces, faces with fewer than 3 distinct corners and duplicate faces are dropped, and edge
 * attributes / loose edges are remapped.
 */
export function mergeVerticesByMap(
  src: MeshData,
  target: ArrayLike<number>,
  positions: number[] = src.positions,
  /** Receives, for every output face, the index of its source face. */
  faceSource?: number[],
): MeshData {
  const n = vertexCount(src);
  const root = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let r = target[i];
    let guard = 0;
    while (r !== target[r] && guard++ < n) r = target[r];
    root[i] = r;
  }
  const newIndex = new Int32Array(n).fill(-1);
  let count = 0;
  for (let i = 0; i < n; i++) if (root[i] === i) newIndex[i] = count++;
  const map = (i: number) => newIndex[root[i]];
  const colors = hasColors(src) ? src.colors! : null;
  const pos = new Array<number>(count * 3);
  const col = colors ? new Array<number>(count * 4) : null;
  for (let i = 0; i < n; i++) {
    const j = newIndex[i];
    if (j < 0) continue;
    pos[j * 3] = positions[i * 3];
    pos[j * 3 + 1] = positions[i * 3 + 1];
    pos[j * 3 + 2] = positions[i * 3 + 2];
    if (col && colors) for (let k = 0; k < 4; k++) col[j * 4 + k] = colors[i * 4 + k];
  }
  const faces: number[][] = [];
  const faceMaterials: number[] = [];
  const faceSmooth: boolean[] = [];
  const uvs: number[][] | null = src.uvs ? [] : null;
  const seen = new Set<string>();
  for (let f = 0; f < src.faces.length; f++) {
    const face = src.faces[f];
    const uv = src.uvs ? src.uvs[f] : null;
    let nf: number[] = [];
    let nuv: number[] = [];
    for (let i = 0; i < face.length; i++) {
      const v = map(face[i]);
      if (nf.length && nf[nf.length - 1] === v) continue;
      nf.push(v);
      if (uv) nuv.push(uv[i * 2] ?? 0, uv[i * 2 + 1] ?? 0);
    }
    while (nf.length > 1 && nf[0] === nf[nf.length - 1]) {
      nf.pop();
      nuv.length = nf.length * 2;
    }
    if (new Set(nf).size !== nf.length) {
      // non-adjacent duplicates (pinched face): keep the first occurrence of each vertex
      const keep: number[] = [];
      const kuv: number[] = [];
      for (let i = 0; i < nf.length; i++) {
        if (keep.includes(nf[i])) continue;
        keep.push(nf[i]);
        kuv.push(nuv[i * 2], nuv[i * 2 + 1]);
      }
      nf = keep;
      nuv = kuv;
    }
    if (nf.length < 3) continue;
    const sig = [...nf].sort((a, b) => a - b).join(',');
    if (seen.has(sig)) continue;
    seen.add(sig);
    faces.push(nf);
    faceMaterials.push(src.faceMaterials[f] ?? 0);
    faceSmooth.push(src.faceSmooth[f] ?? false);
    if (uvs) uvs.push(nuv);
    faceSource?.push(f);
  }
  const faceEdges = new Set<string>();
  for (const f of faces)
    for (let i = 0; i < f.length; i++) faceEdges.add(edgeKey(f[i], f[(i + 1) % f.length]));
  const looseEdges: number[] = [];
  const looseSeen = new Set<string>();
  for (let i = 0; i + 1 < src.looseEdges.length; i += 2) {
    const a = map(src.looseEdges[i]);
    const b = map(src.looseEdges[i + 1]);
    if (a === b) continue;
    const k = edgeKey(a, b);
    if (faceEdges.has(k) || looseSeen.has(k)) continue;
    looseSeen.add(k);
    looseEdges.push(a, b);
  }
  const edgeAttrs: Record<string, EdgeAttr> = {};
  for (const k in src.edgeAttrs) {
    const [a, b] = parseEdgeKey(k);
    if (a >= n || b >= n) continue;
    const ma = map(a);
    const mb = map(b);
    if (ma === mb) continue;
    const nk = edgeKey(ma, mb);
    if (!faceEdges.has(nk) && !looseSeen.has(nk)) continue;
    const c = cleanEdgeAttr(src.edgeAttrs[k]);
    if (c) edgeAttrs[nk] = mergeEdgeAttr(edgeAttrs[nk], c);
  }
  return { positions: pos, faces, faceMaterials, faceSmooth, uvs, colors: col, edgeAttrs, looseEdges };
}

/** Union-find over vertex indices; the representative of a set is its smallest index. */
export class UnionFind {
  readonly parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(i: number): number {
    const p = this.parent;
    let r = i;
    while (p[r] !== r) r = p[r];
    while (p[i] !== r) {
      const next = p[i];
      p[i] = r;
      i = next;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (ra < rb) this.parent[rb] = ra;
    else this.parent[ra] = rb;
  }
  /** Fully resolved representative map. */
  roots(): Int32Array {
    const out = new Int32Array(this.parent.length);
    for (let i = 0; i < out.length; i++) out[i] = this.find(i);
    return out;
  }
}

// ------------------------------------------------------------------ spatial hash

/** Uniform grid for radius queries over points. */
export class PointGrid {
  private readonly cells = new Map<string, number[]>();
  private readonly pts: number[] = [];
  constructor(private readonly cell: number) {
    if (!(cell > 0)) this.cell = 1e-6;
  }

  private key(ix: number, iy: number, iz: number): string {
    return `${ix},${iy},${iz}`;
  }

  /** Inserts a point with an id. */
  insert(id: number, x: number, y: number, z: number): void {
    const slot = this.pts.length;
    this.pts.push(x, y, z, id);
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell), Math.floor(z / this.cell));
    const c = this.cells.get(k);
    if (c) c.push(slot);
    else this.cells.set(k, [slot]);
  }

  /** Nearest inserted point within `radius` (radius should be <= the cell size); returns its id or -1. */
  nearest(x: number, y: number, z: number, radius: number, accept?: (id: number) => boolean): number {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    const cz = Math.floor(z / this.cell);
    const r2 = radius * radius;
    let best = -1;
    let bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const c = this.cells.get(this.key(cx + dx, cy + dy, cz + dz));
          if (!c) continue;
          for (const s of c) {
            const ex = this.pts[s] - x;
            const ey = this.pts[s + 1] - y;
            const ez = this.pts[s + 2] - z;
            const d = ex * ex + ey * ey + ez * ez;
            if (d <= r2 && d < bestD) {
              const id = this.pts[s + 3];
              if (accept && !accept(id)) continue;
              bestD = d;
              best = id;
            }
          }
        }
    return best;
  }
}

// ------------------------------------------------------------------ geometry helpers

/** Unit face normals (Newell), 3 per face (zero for degenerate faces). */
export function faceNormalsOf(m: MeshData): Float64Array {
  const out = new Float64Array(m.faces.length * 3);
  const p = m.positions;
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < face.length; i++) {
      const a = face[i] * 3;
      const b = face[(i + 1) % face.length] * 3;
      nx += (p[a + 1] - p[b + 1]) * (p[a + 2] + p[b + 2]);
      ny += (p[a + 2] - p[b + 2]) * (p[a] + p[b]);
      nz += (p[a] - p[b]) * (p[a + 1] + p[b + 1]);
    }
    const l = Math.hypot(nx, ny, nz);
    if (l > 1e-30) {
      out[f * 3] = nx / l;
      out[f * 3 + 1] = ny / l;
      out[f * 3 + 2] = nz / l;
    }
  }
  return out;
}

/** Interior angle of `face` at corner i. */
export function cornerAngle(p: ArrayLike<number>, face: number[], i: number): number {
  const n = face.length;
  const v = face[i] * 3;
  const a = face[(i + n - 1) % n] * 3;
  const b = face[(i + 1) % n] * 3;
  const ax = p[a] - p[v];
  const ay = p[a + 1] - p[v + 1];
  const az = p[a + 2] - p[v + 2];
  const bx = p[b] - p[v];
  const by = p[b + 1] - p[v + 1];
  const bz = p[b + 2] - p[v + 2];
  const la = Math.hypot(ax, ay, az);
  const lb = Math.hypot(bx, by, bz);
  if (la < 1e-30 || lb < 1e-30) return 0;
  const c = (ax * bx + ay * by + az * bz) / (la * lb);
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

/** Angle-weighted unit vertex normals (3 per vertex; zero for vertices without faces). */
export function vertexNormalsOf(m: MeshData, faceNormals = faceNormalsOf(m)): Float64Array {
  const n = vertexCount(m);
  const out = new Float64Array(n * 3);
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    const nx = faceNormals[f * 3];
    const ny = faceNormals[f * 3 + 1];
    const nz = faceNormals[f * 3 + 2];
    for (let i = 0; i < face.length; i++) {
      const w = cornerAngle(m.positions, face, i);
      const v = face[i] * 3;
      out[v] += nx * w;
      out[v + 1] += ny * w;
      out[v + 2] += nz * w;
    }
  }
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]);
    if (l > 1e-30) {
      out[i * 3] /= l;
      out[i * 3 + 1] /= l;
      out[i * 3 + 2] /= l;
    }
  }
  return out;
}

/**
 * Per-vertex factor that keeps a shell at constant distance from the faces when offsetting along the
 * vertex normal (1 / angle-weighted mean cosine between vertex and face normals, clamped to <= 4).
 */
export function evenOffsetFactors(m: MeshData, vn: Float64Array, fn: Float64Array): Float64Array {
  const n = vertexCount(m);
  const sumW = new Float64Array(n);
  const sumD = new Float64Array(n);
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    for (let i = 0; i < face.length; i++) {
      const v = face[i];
      const w = cornerAngle(m.positions, face, i);
      const d = vn[v * 3] * fn[f * 3] + vn[v * 3 + 1] * fn[f * 3 + 1] + vn[v * 3 + 2] * fn[f * 3 + 2];
      sumW[v] += w;
      sumD[v] += w * d;
    }
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = sumW[i] > 0 ? 1 / Math.max(0.25, sumD[i] / sumW[i]) : 1;
  return out;
}

export function transformPositions(
  src: ArrayLike<number>,
  m: Mat4,
  out: number[] = new Array<number>(src.length),
): number[] {
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i];
    const y = src[i + 1];
    const z = src[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

/** Determinant of the upper 3x3 part of an affine matrix. */
export function det3(m: Mat4): number {
  return (
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2])
  );
}

/** Bounding-box diagonal length of a position array (0 for empty input). */
export function boundsDiagonal(p: ArrayLike<number>): number {
  if (p.length < 3) return 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < x0) x0 = p[i];
    if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1];
    if (p[i + 1] > y1) y1 = p[i + 1];
    if (p[i + 2] < z0) z0 = p[i + 2];
    if (p[i + 2] > z1) z1 = p[i + 2];
  }
  return Math.hypot(x1 - x0, y1 - y0, z1 - z0);
}

// ------------------------------------------------------------------ helper objects

/** World matrix of another object, or null when it does not exist / is not available. */
export function objectWorldMatrix(ctx: ModifierContext, id: string | null | undefined): Mat4 | null {
  if (!id) return null;
  const m = ctx.getObjectMatrix?.(id);
  if (m) return m;
  return ctx.getObjectMesh(id)?.matrix ?? null;
}

/**
 * Matrix mapping owner-local coordinates into the local space of object `id`
 * (inverse(objectWorld) · ownerWorld), or null when the object is unavailable.
 */
export function ownerToObjectSpace(ctx: ModifierContext, id: string | null | undefined): Mat4 | null {
  const w = objectWorldMatrix(ctx, id);
  return w ? multiply4(invert4(w), ctx.objectMatrix) : null;
}

/** Matrix mapping the local space of object `id` into owner-local coordinates (inverse(ownerWorld) · objectWorld). */
export function objectToOwnerSpace(ctx: ModifierContext, id: string | null | undefined): Mat4 | null {
  const w = objectWorldMatrix(ctx, id);
  return w ? multiply4(invert4(ctx.objectMatrix), w) : null;
}

/** Deterministic PRNG (mulberry32) returning floats in [0, 1). */
export function makeRandom(seed: number): () => number {
  let s = (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
