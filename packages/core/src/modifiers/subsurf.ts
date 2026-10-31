import { z } from 'zod';
import type { EdgeAttr, MeshData } from '../mesh/types';
import { edgeKey, vertexCount } from '../mesh/types';
import { buildTopology } from '../mesh/topology';
import type { ModifierDef } from './registry';
import { cleanEdgeAttr, hasColors } from './util';

const schema = z.object({
  levels: z.number().int().min(0).max(6).default(1).describe('Subdivision levels used in the viewport'),
  render_levels: z
    .number()
    .int()
    .min(0)
    .max(6)
    .default(2)
    .describe('Subdivision levels used for final renders'),
  subdivision_type: z
    .enum(['CATMULL_CLARK', 'SIMPLE'])
    .default('CATMULL_CLARK')
    .describe('CATMULL_CLARK smooths the surface; SIMPLE only splits faces'),
  use_creases: z.boolean().default(true).describe('Honour edge crease weights (0..1) as semi-sharp creases'),
  boundary_smooth: z
    .enum(['ALL', 'PRESERVE_CORNERS'])
    .default('ALL')
    .describe('PRESERVE_CORNERS keeps boundary corner vertices (one face, two boundary edges) in place'),
  quality: z.number().int().min(1).max(10).default(3).describe('Accepted for compatibility (no effect)'),
  use_limit_surface: z.boolean().default(true).describe('Accepted for compatibility (no effect)'),
});

export type SubsurfParams = z.infer<typeof schema>;

/** Crease weight (0..1) → subdivision sharpness (number of sharp levels; 1 = infinitely sharp). */
function creaseToSharpness(c: number | undefined): number {
  if (!c || !(c > 0)) return 0;
  if (c >= 1) return Infinity;
  return c / (1 - c);
}

function sharpnessToCrease(s: number): number {
  if (!(s > 0)) return 0;
  if (s === Infinity) return 1;
  return s / (1 + s);
}

/**
 * One level of Catmull–Clark (or simple) subdivision of an n-gon mesh.
 *
 * - Boundary, non-manifold and loose edges are treated as infinitely sharp creases (B-spline curves).
 * - Semi-sharp creases follow the classic DeRose et al. rules: sharpness s >= 1 uses crease rules,
 *   0 < s < 1 blends linearly between smooth and sharp results, and child edges get s - 1.
 * - UVs are interpolated linearly per face corner, vertex colors linearly.
 */
export function subdivideOnce(
  m: MeshData,
  smooth: boolean,
  useCreases: boolean,
  preserveCorners = false,
): MeshData {
  const topo = buildTopology(m);
  const nv = vertexCount(m);
  const ne = topo.edges.length;
  const nf = m.faces.length;
  const P = m.positions;
  const fBase = nv + ne;
  const total = fBase + nf;
  const out = new Array<number>(total * 3);

  // face points
  for (let f = 0; f < nf; f++) {
    const face = m.faces[f];
    let x = 0;
    let y = 0;
    let z = 0;
    for (const v of face) {
      x += P[v * 3];
      y += P[v * 3 + 1];
      z += P[v * 3 + 2];
    }
    const inv = 1 / Math.max(1, face.length);
    out[(fBase + f) * 3] = x * inv;
    out[(fBase + f) * 3 + 1] = y * inv;
    out[(fBase + f) * 3 + 2] = z * inv;
  }

  // edge sharpness: boundary / non-manifold / loose edges are always sharp
  const sharp = new Float64Array(ne);
  for (let e = 0; e < ne; e++) {
    if (topo.edgeFaces[e].length !== 2) sharp[e] = Infinity;
    else if (useCreases) {
      const [a, b] = topo.edges[e];
      sharp[e] = creaseToSharpness(m.edgeAttrs[edgeKey(a, b)]?.crease);
    }
  }

  // edge points
  for (let e = 0; e < ne; e++) {
    const [a, b] = topo.edges[e];
    const o = (nv + e) * 3;
    const mx = (P[a * 3] + P[b * 3]) / 2;
    const my = (P[a * 3 + 1] + P[b * 3 + 1]) / 2;
    const mz = (P[a * 3 + 2] + P[b * 3 + 2]) / 2;
    const s = sharp[e];
    if (!smooth || s >= 1 || topo.edgeFaces[e].length !== 2) {
      out[o] = mx;
      out[o + 1] = my;
      out[o + 2] = mz;
      continue;
    }
    const f0 = (fBase + topo.edgeFaces[e][0]) * 3;
    const f1 = (fBase + topo.edgeFaces[e][1]) * 3;
    const sx = (P[a * 3] + P[b * 3] + out[f0] + out[f1]) / 4;
    const sy = (P[a * 3 + 1] + P[b * 3 + 1] + out[f0 + 1] + out[f1 + 1]) / 4;
    const sz = (P[a * 3 + 2] + P[b * 3 + 2] + out[f0 + 2] + out[f1 + 2]) / 4;
    out[o] = sx + (mx - sx) * s;
    out[o + 1] = sy + (my - sy) * s;
    out[o + 2] = sz + (mz - sz) * s;
  }

  // vertex points
  for (let v = 0; v < nv; v++) {
    const o = v * 3;
    const px = P[o];
    const py = P[o + 1];
    const pz = P[o + 2];
    const edges = topo.vertEdges[v];
    const faces = topo.vertFaces[v];
    if (!smooth || edges.length === 0) {
      out[o] = px;
      out[o + 1] = py;
      out[o + 2] = pz;
      continue;
    }
    // smooth (interior) rule
    let smx = px;
    let smy = py;
    let smz = pz;
    if (faces.length > 0) {
      let fx = 0;
      let fy = 0;
      let fz = 0;
      for (const f of faces) {
        fx += out[(fBase + f) * 3];
        fy += out[(fBase + f) * 3 + 1];
        fz += out[(fBase + f) * 3 + 2];
      }
      fx /= faces.length;
      fy /= faces.length;
      fz /= faces.length;
      let rx = 0;
      let ry = 0;
      let rz = 0;
      let n = 0;
      for (const e of edges) {
        if (topo.edgeFaces[e].length === 0) continue;
        const [a, b] = topo.edges[e];
        rx += (P[a * 3] + P[b * 3]) / 2;
        ry += (P[a * 3 + 1] + P[b * 3 + 1]) / 2;
        rz += (P[a * 3 + 2] + P[b * 3 + 2]) / 2;
        n++;
      }
      if (n > 0) {
        rx /= n;
        ry /= n;
        rz /= n;
        smx = (fx + 2 * rx + (n - 3) * px) / n;
        smy = (fy + 2 * ry + (n - 3) * py) / n;
        smz = (fz + 2 * rz + (n - 3) * pz) / n;
      }
    }
    // crease / corner rules
    const sharpEdges: number[] = [];
    let sharpSum = 0;
    let boundaryEdges = 0;
    for (const e of edges) {
      if (topo.edgeFaces[e].length === 1) boundaryEdges++;
      if (sharp[e] > 0) {
        sharpEdges.push(e);
        sharpSum += Math.min(sharp[e], 1);
      }
    }
    const k = sharpEdges.length;
    if (k < 2) {
      out[o] = smx;
      out[o + 1] = smy;
      out[o + 2] = smz;
      continue;
    }
    let shx = px;
    let shy = py;
    let shz = pz;
    const corner = preserveCorners && faces.length === 1 && boundaryEdges === 2;
    if (k === 2 && !corner) {
      const other = (e: number) => (topo.edges[e][0] === v ? topo.edges[e][1] : topo.edges[e][0]);
      const a = other(sharpEdges[0]) * 3;
      const b = other(sharpEdges[1]) * 3;
      shx = (P[a] + 6 * px + P[b]) / 8;
      shy = (P[a + 1] + 6 * py + P[b + 1]) / 8;
      shz = (P[a + 2] + 6 * pz + P[b + 2]) / 8;
    }
    const t = faces.length === 0 ? 1 : Math.min(1, sharpSum / k);
    out[o] = smx + (shx - smx) * t;
    out[o + 1] = smy + (shy - smy) * t;
    out[o + 2] = smz + (shz - smz) * t;
  }

  // colors (linear)
  let colors: number[] | null = null;
  if (hasColors(m)) {
    const C = m.colors!;
    colors = new Array<number>(total * 4);
    for (let i = 0; i < nv * 4; i++) colors[i] = C[i];
    for (let e = 0; e < ne; e++) {
      const [a, b] = topo.edges[e];
      for (let k = 0; k < 4; k++) colors[(nv + e) * 4 + k] = (C[a * 4 + k] + C[b * 4 + k]) / 2;
    }
    for (let f = 0; f < nf; f++) {
      const face = m.faces[f];
      for (let k = 0; k < 4; k++) {
        let s = 0;
        for (const v of face) s += C[v * 4 + k];
        colors[(fBase + f) * 4 + k] = s / Math.max(1, face.length);
      }
    }
  }

  // faces (one quad per corner) with linearly interpolated corner UVs
  const faces: number[][] = [];
  const faceMaterials: number[] = [];
  const faceSmooth: boolean[] = [];
  const uvs: number[][] | null = m.uvs ? [] : null;
  for (let f = 0; f < nf; f++) {
    const face = m.faces[f];
    const n = face.length;
    if (n < 3) continue;
    const fe = topo.faceEdges[f];
    const fp = fBase + f;
    const uv = m.uvs ? m.uvs[f] : null;
    let cu = 0;
    let cv = 0;
    if (uv) {
      for (let i = 0; i < n; i++) {
        cu += uv[i * 2] ?? 0;
        cv += uv[i * 2 + 1] ?? 0;
      }
      cu /= n;
      cv /= n;
    }
    for (let i = 0; i < n; i++) {
      const ip = (i + n - 1) % n;
      const inx = (i + 1) % n;
      faces.push([face[i], nv + fe[i], fp, nv + fe[ip]]);
      faceMaterials.push(m.faceMaterials[f] ?? 0);
      faceSmooth.push(m.faceSmooth[f] ?? false);
      if (uvs) {
        if (uv) {
          const u0 = uv[i * 2] ?? 0;
          const v0 = uv[i * 2 + 1] ?? 0;
          uvs.push([
            u0,
            v0,
            (u0 + (uv[inx * 2] ?? 0)) / 2,
            (v0 + (uv[inx * 2 + 1] ?? 0)) / 2,
            cu,
            cv,
            (u0 + (uv[ip * 2] ?? 0)) / 2,
            (v0 + (uv[ip * 2 + 1] ?? 0)) / 2,
          ]);
        } else uvs.push([0, 0, 0, 0, 0, 0, 0, 0]);
      }
    }
  }

  // loose edges are split in two
  const looseEdges: number[] = [];
  for (let i = 0; i + 1 < m.looseEdges.length; i += 2) {
    const e = topo.edgeIndex.get(edgeKey(m.looseEdges[i], m.looseEdges[i + 1]));
    if (e === undefined || topo.edgeFaces[e].length > 0) continue;
    const [a, b] = topo.edges[e];
    looseEdges.push(a, nv + e, nv + e, b);
  }

  // edge attributes propagate to both child edges (creases lose one level of sharpness)
  const edgeAttrs: Record<string, EdgeAttr> = {};
  for (const key in m.edgeAttrs) {
    const e = topo.edgeIndex.get(key);
    if (e === undefined) continue;
    const src = m.edgeAttrs[key];
    const attr: EdgeAttr = { ...src };
    if (useCreases && smooth && src.crease) {
      attr.crease = sharpnessToCrease(Math.max(0, creaseToSharpness(src.crease) - 1));
    }
    const c = cleanEdgeAttr(attr);
    if (!c) continue;
    const [a, b] = topo.edges[e];
    edgeAttrs[edgeKey(a, nv + e)] = { ...c };
    edgeAttrs[edgeKey(nv + e, b)] = { ...c };
  }

  return { positions: out, faces, faceMaterials, faceSmooth, uvs, colors, edgeAttrs, looseEdges };
}

/** Applies `levels` subdivision steps. */
export function subdivideMesh(m: MeshData, levels: number, p: Partial<SubsurfParams> = {}): MeshData {
  let cur = m;
  const smooth = (p.subdivision_type ?? 'CATMULL_CLARK') === 'CATMULL_CLARK';
  for (let l = 0; l < levels; l++) {
    cur = subdivideOnce(cur, smooth, p.use_creases ?? true, p.boundary_smooth === 'PRESERVE_CORNERS');
  }
  return cur;
}

export const subsurfModifier: ModifierDef<typeof schema> = {
  type: 'SUBSURF',
  label: 'Subdivision Surface',
  category: 'GENERATE',
  description:
    'Subdivides every face into quads (one per corner) `levels` times (`render_levels` for renders), smoothing with ' +
    'Catmull–Clark rules or keeping the shape (SIMPLE). Works on n-gons, open boundaries (kept as smooth curves) and ' +
    'loose edges; edge creases (0..1) make edges semi-sharp (1 = fully sharp). Each level multiplies the face count by ~4. ' +
    'UVs and vertex colors are interpolated linearly. Limitation: the limit-surface projection is not applied.',
  schema,
  apply(mesh, p, ctx) {
    const levels = ctx.forRender ? p.render_levels : p.levels;
    if (levels <= 0 || mesh.positions.length === 0) return mesh;
    const projected = mesh.faces.reduce((s, f) => s + f.length, 0) * 4 ** (levels - 1);
    if (projected > 4_000_000)
      throw new Error(`Subdivision result too large (~${projected} faces); lower the levels`);
    return subdivideMesh(mesh, levels, p);
  },
};
