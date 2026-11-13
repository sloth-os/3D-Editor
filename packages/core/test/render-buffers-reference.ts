// The render buffers as buildRenderBuffers made them before it used typed arrays (round 9): per
// corner strings in a Map, per-edge arrays of the mesh topology. Kept verbatim as the reference the
// typed-array version must match number for number (render-buffers-memory.test.ts).
import {
  buildTopology,
  edgeKey,
  faceNormalRaw,
  triangulateFaceCorners,
  vertexCount,
  type MeshData,
  type RenderBuffers,
} from '../src/mesh';

export function referenceBuildRenderBuffers(m: MeshData): RenderBuffers {
  const topo = buildTopology(m);
  const nCorners = topo.cornerCount;
  const p = m.positions;

  // --- face normals (unit) and corner angle weights
  const faceN = new Float64Array(m.faces.length * 3);
  for (let f = 0; f < m.faces.length; f++) {
    const n = faceNormalRaw(m, f);
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    faceN[f * 3] = n[0] / l;
    faceN[f * 3 + 1] = n[1] / l;
    faceN[f * 3 + 2] = n[2] / l;
  }

  // --- union-find over corners to build smoothing fans
  const parent = new Int32Array(nCorners);
  for (let i = 0; i < nCorners; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const cornerOf = (f: number, v: number): number => {
    const face = m.faces[f];
    const i = face.indexOf(v);
    return i < 0 ? -1 : topo.faceCornerStart[f] + i;
  };
  for (let e = 0; e < topo.edges.length; e++) {
    const ef = topo.edgeFaces[e];
    if (ef.length !== 2) continue;
    const [f0, f1] = ef;
    if (!m.faceSmooth[f0] || !m.faceSmooth[f1]) continue;
    const [a, b] = topo.edges[e];
    if (m.edgeAttrs[edgeKey(a, b)]?.sharp) continue;
    for (const v of [a, b]) {
      const c0 = cornerOf(f0, v);
      const c1 = cornerOf(f1, v);
      if (c0 >= 0 && c1 >= 0) union(c0, c1);
    }
  }

  // --- accumulate angle-weighted normals per fan root
  const fanN = new Float64Array(nCorners * 3);
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    const n = face.length;
    for (let i = 0; i < n; i++) {
      const c = topo.faceCornerStart[f] + i;
      let w = 1;
      if (m.faceSmooth[f]) {
        const v = face[i] * 3;
        const prev = face[(i + n - 1) % n] * 3;
        const next = face[(i + 1) % n] * 3;
        const ax = p[prev] - p[v];
        const ay = p[prev + 1] - p[v + 1];
        const az = p[prev + 2] - p[v + 2];
        const bx = p[next] - p[v];
        const by = p[next + 1] - p[v + 1];
        const bz = p[next + 2] - p[v + 2];
        const la = Math.hypot(ax, ay, az);
        const lb = Math.hypot(bx, by, bz);
        if (la > 0 && lb > 0) {
          const cos = (ax * bx + ay * by + az * bz) / (la * lb);
          w = Math.acos(Math.max(-1, Math.min(1, cos)));
        }
      }
      const r = find(c);
      fanN[r * 3] += faceN[f * 3] * w;
      fanN[r * 3 + 1] += faceN[f * 3 + 1] * w;
      fanN[r * 3 + 2] += faceN[f * 3 + 2] * w;
    }
  }

  // --- emit render vertices (deduplicated per vertex + fan + uv)
  const hasUV = !!m.uvs;
  const hasColor = !!m.colors && m.colors.length === vertexCount(m) * 4;
  const posOut: number[] = [];
  const nrmOut: number[] = [];
  const uvOut: number[] = [];
  const colOut: number[] = [];
  const srcOut: number[] = [];
  const cornerVertex = new Int32Array(nCorners);
  const dedupe = new Map<string, number>();
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    const uv = hasUV ? m.uvs![f] : null;
    for (let i = 0; i < face.length; i++) {
      const c = topo.faceCornerStart[f] + i;
      const v = face[i];
      const r = find(c);
      const u0 = uv ? uv[i * 2] : 0;
      const u1 = uv ? uv[i * 2 + 1] : 0;
      const key = hasUV ? `${v}|${r}|${u0}|${u1}` : `${v}|${r}`;
      let idx = dedupe.get(key);
      if (idx === undefined) {
        idx = srcOut.length;
        dedupe.set(key, idx);
        posOut.push(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
        const nx = fanN[r * 3];
        const ny = fanN[r * 3 + 1];
        const nz = fanN[r * 3 + 2];
        const l = Math.hypot(nx, ny, nz) || 1;
        nrmOut.push(nx / l, ny / l, nz / l);
        if (hasUV) uvOut.push(u0, u1);
        if (hasColor) {
          const cc = m.colors!;
          colOut.push(cc[v * 4], cc[v * 4 + 1], cc[v * 4 + 2], cc[v * 4 + 3]);
        }
        srcOut.push(v);
      }
      cornerVertex[c] = idx;
    }
  }

  // --- triangles grouped by material
  const byMaterial = new Map<number, { tris: number[]; faces: number[] }>();
  for (let f = 0; f < m.faces.length; f++) {
    const mat = m.faceMaterials[f] ?? 0;
    let bucket = byMaterial.get(mat);
    if (!bucket) {
      bucket = { tris: [], faces: [] };
      byMaterial.set(mat, bucket);
    }
    const corners = triangulateFaceCorners(m, f);
    const base = topo.faceCornerStart[f];
    for (let i = 0; i < corners.length; i += 3) {
      bucket.tris.push(
        cornerVertex[base + corners[i]],
        cornerVertex[base + corners[i + 1]],
        cornerVertex[base + corners[i + 2]],
      );
      bucket.faces.push(f);
    }
  }
  const mats = [...byMaterial.keys()].sort((a, b) => a - b);
  let total = 0;
  for (const k of mats) total += byMaterial.get(k)!.tris.length;
  const indices = new Uint32Array(total);
  const triFace = new Uint32Array(total / 3);
  const groups: RenderBuffers['groups'] = [];
  let o = 0;
  for (const k of mats) {
    const b = byMaterial.get(k)!;
    indices.set(b.tris, o);
    triFace.set(b.faces, o / 3);
    groups.push({ start: o, count: b.tris.length, materialIndex: k });
    o += b.tris.length;
  }

  return {
    positions: new Float32Array(posOut),
    normals: new Float32Array(nrmOut),
    uvs: hasUV ? new Float32Array(uvOut) : null,
    colors: hasColor ? new Float32Array(colOut) : null,
    indices,
    groups,
    triFace,
    vertexSource: new Uint32Array(srcOut),
  };
}
