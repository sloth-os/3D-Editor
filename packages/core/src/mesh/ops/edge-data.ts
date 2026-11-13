import type { EdgeAttr, MeshData } from '../types';
import { cloneMesh, edgeKey } from '../types';
import type { MeshSelection } from '../selection';
import { buildTopology } from '../topology';
import type { MeshOpResult } from './types';
import { completeSelection, requireNonEmpty, setEdgeAttr } from './util';

function editEdges(src: MeshData, keys: Iterable<string>, edit: (a: EdgeAttr) => EdgeAttr): MeshData {
  const m = cloneMesh(src);
  for (const k of keys) setEdgeAttr(m, k, edit({ ...(m.edgeAttrs[k] ?? {}) }));
  return m;
}

function selectedEdgeKeys(src: MeshData, sel: MeshSelection): string[] {
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  requireNonEmpty(s.edges.size, 'edges');
  return [...s.edges];
}

/** Marks (or clears) the selected edges as UV seams. */
export function markSeam(src: MeshData, sel: MeshSelection, clear = false): MeshOpResult {
  const mesh = editEdges(src, selectedEdgeKeys(src, sel), (a) => ({ ...a, seam: !clear }));
  return { mesh, selection: sel };
}

/**
 * Marks (or clears) the selected edges as sharp. With `useVerts`, every edge touching a selected
 * vertex is affected.
 */
export function markSharp(
  src: MeshData,
  sel: MeshSelection,
  opts: { clear?: boolean; useVerts?: boolean } = {},
): MeshOpResult {
  let keys: string[];
  if (opts.useVerts) {
    const topo = buildTopology(src);
    const s = completeSelection(src, sel, topo);
    requireNonEmpty(s.verts.size, 'vertices');
    keys = topo.edges.filter(([a, b]) => s.verts.has(a) || s.verts.has(b)).map(([a, b]) => edgeKey(a, b));
  } else keys = selectedEdgeKeys(src, sel);
  const mesh = editEdges(src, keys, (a) => ({ ...a, sharp: !opts.clear }));
  return { mesh, selection: sel };
}

/** Sets the subdivision crease weight (0..1) of the selected edges (0 removes the crease). */
export function setEdgeCrease(src: MeshData, sel: MeshSelection, value: number): MeshOpResult {
  const v = Math.max(0, Math.min(1, value));
  const mesh = editEdges(src, selectedEdgeKeys(src, sel), (a) => ({ ...a, crease: v }));
  return { mesh, selection: sel };
}
