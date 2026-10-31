import { z } from 'zod';
import type { MeshData } from '../mesh/types';
import { vertexCount } from '../mesh/types';
import { buildTopology } from '../mesh/topology';
import { mergeByDistance } from '../mesh/weld';
import type { ModifierDef } from './registry';
import { UnionFind, mergeVerticesByMap } from './util';

const schema = z.object({
  merge_threshold: z.number().min(0).default(0.001).describe('Vertices closer than this distance are merged'),
  mode: z
    .enum(['ALL', 'CONNECTED'])
    .default('ALL')
    .describe('ALL merges any close vertices; CONNECTED only collapses edges shorter than the threshold'),
  loose_edges: z.boolean().default(false).describe('CONNECTED mode: only collapse loose (wire) edges'),
});

/** Collapses edges shorter than `threshold` (vertices move to the cluster centroid). */
export function weldConnected(m: MeshData, threshold: number, onlyLoose = false): MeshData {
  const topo = buildTopology(m);
  const n = vertexCount(m);
  const P = m.positions;
  const uf = new UnionFind(n);
  const t2 = threshold * threshold;
  let any = false;
  for (let e = 0; e < topo.edges.length; e++) {
    if (onlyLoose && topo.edgeFaces[e].length > 0) continue;
    const [a, b] = topo.edges[e];
    const dx = P[a * 3] - P[b * 3];
    const dy = P[a * 3 + 1] - P[b * 3 + 1];
    const dz = P[a * 3 + 2] - P[b * 3 + 2];
    if (dx * dx + dy * dy + dz * dz <= t2) {
      uf.union(a, b);
      any = true;
    }
  }
  if (!any) return m;
  const roots = uf.roots();
  const sum = new Float64Array(n * 3);
  const cnt = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const r = roots[i];
    sum[r * 3] += P[i * 3];
    sum[r * 3 + 1] += P[i * 3 + 1];
    sum[r * 3 + 2] += P[i * 3 + 2];
    cnt[r]++;
  }
  const positions = P.slice();
  for (let i = 0; i < n; i++) {
    if (roots[i] !== i || cnt[i] < 2) continue;
    for (let k = 0; k < 3; k++) positions[i * 3 + k] = sum[i * 3 + k] / cnt[i];
  }
  return mergeVerticesByMap(m, roots, positions);
}

export const weldModifier: ModifierDef<typeof schema> = {
  type: 'WELD',
  label: 'Weld',
  category: 'GENERATE',
  description:
    'Merges vertices that are closer than `merge_threshold` (like Merge by Distance). Mode ALL merges any close ' +
    'vertices; CONNECTED only collapses short edges. Faces that collapse below 3 corners are removed.',
  schema,
  apply(mesh, p) {
    if (vertexCount(mesh) === 0) return mesh;
    if (p.mode === 'CONNECTED') return weldConnected(mesh, p.merge_threshold, p.loose_edges);
    const r = mergeByDistance(mesh, p.merge_threshold);
    return r.removed > 0 ? r.mesh : mesh;
  },
};
