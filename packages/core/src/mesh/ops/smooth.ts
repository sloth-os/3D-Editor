import type { MeshData } from '../types';
import { cloneMesh } from '../types';
import type { MeshSelection } from '../selection';
import { buildTopology } from '../topology';
import type { MeshOpResult } from './types';
import { completeSelection, requireNonEmpty } from './util';

export interface SmoothOptions {
  /** 0..1 blend towards the neighbour average per iteration (default 0.5). */
  factor?: number;
  /** Number of iterations (default 1). */
  repeat?: number;
  /** Axes that may move (default all). */
  xaxis?: boolean;
  yaxis?: boolean;
  zaxis?: boolean;
}

/**
 * Laplacian smoothing of the selected vertices. Boundary vertices are only averaged with their
 * boundary neighbours so open outlines keep their shape.
 */
export function smoothVertices(src: MeshData, sel: MeshSelection, opts: SmoothOptions = {}): MeshOpResult {
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  requireNonEmpty(s.verts.size, 'vertices');
  const factor = opts.factor ?? 0.5;
  const repeat = Math.max(1, Math.floor(opts.repeat ?? 1));
  const axes = [opts.xaxis ?? true, opts.yaxis ?? true, opts.zaxis ?? true];
  const verts = [...s.verts];
  const neighbours = verts.map((v) => {
    const edges = topo.vertEdges[v];
    const boundary = edges.filter((e) => topo.edgeFaces[e].length === 1);
    const use = boundary.length >= 2 ? boundary : edges;
    return use.map((e) => (topo.edges[e][0] === v ? topo.edges[e][1] : topo.edges[e][0]));
  });
  const m = cloneMesh(src);
  for (let it = 0; it < repeat; it++) {
    const prev = m.positions.slice();
    verts.forEach((v, i) => {
      const nb = neighbours[i];
      if (nb.length === 0) return;
      for (let k = 0; k < 3; k++) {
        if (!axes[k]) continue;
        let avg = 0;
        for (const w of nb) avg += prev[w * 3 + k];
        avg /= nb.length;
        m.positions[v * 3 + k] = prev[v * 3 + k] + (avg - prev[v * 3 + k]) * factor;
      }
    });
  }
  return { mesh: m, selection: s };
}
