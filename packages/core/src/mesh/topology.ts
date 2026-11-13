import type { MeshData } from './types';
import { edgeKey, vertexCount } from './types';

/**
 * Derived adjacency information for a MeshData. Build it once per operation; it is invalidated
 * by any change to faces/looseEdges.
 */
export interface Topology {
  /** Unique undirected edges [a, b] with a < b (face edges first, then loose edges). */
  edges: [number, number][];
  /** edgeKey → index into `edges`. */
  edgeIndex: Map<string, number>;
  /** Faces using each edge. */
  edgeFaces: number[][];
  /** Edges incident to each vertex. */
  vertEdges: number[][];
  /** Faces incident to each vertex. */
  vertFaces: number[][];
  /** For each face, the edge index between corner i and corner i+1. */
  faceEdges: number[][];
  /** Offset of each face's first corner in a flat corner numbering. */
  faceCornerStart: number[];
  cornerCount: number;
}

export function buildTopology(m: MeshData): Topology {
  const nv = vertexCount(m);
  const edges: [number, number][] = [];
  const edgeIndex = new Map<string, number>();
  const edgeFaces: number[][] = [];
  const vertEdges: number[][] = Array.from({ length: nv }, () => []);
  const vertFaces: number[][] = Array.from({ length: nv }, () => []);
  const faceEdges: number[][] = new Array(m.faces.length);
  const faceCornerStart: number[] = new Array(m.faces.length);
  let corner = 0;

  const getEdge = (a: number, b: number): number => {
    const k = edgeKey(a, b);
    let e = edgeIndex.get(k);
    if (e === undefined) {
      e = edges.length;
      edges.push(a < b ? [a, b] : [b, a]);
      edgeIndex.set(k, e);
      edgeFaces.push([]);
      vertEdges[a].push(e);
      vertEdges[b].push(e);
    }
    return e;
  };

  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    faceCornerStart[f] = corner;
    corner += face.length;
    const fe: number[] = new Array(face.length);
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      const e = getEdge(a, b);
      fe[i] = e;
      const ef = edgeFaces[e];
      if (ef[ef.length - 1] !== f) ef.push(f);
      const vf = vertFaces[a];
      if (vf[vf.length - 1] !== f) vf.push(f);
    }
    faceEdges[f] = fe;
  }
  for (let i = 0; i < m.looseEdges.length; i += 2) {
    const a = m.looseEdges[i];
    const b = m.looseEdges[i + 1];
    if (a !== b) getEdge(a, b);
  }
  return {
    edges,
    edgeIndex,
    edgeFaces,
    vertEdges,
    vertFaces,
    faceEdges,
    faceCornerStart,
    cornerCount: corner,
  };
}

/** Edges with exactly one adjacent face. */
export function boundaryEdges(topo: Topology): number[] {
  const out: number[] = [];
  for (let e = 0; e < topo.edges.length; e++) if (topo.edgeFaces[e].length === 1) out.push(e);
  return out;
}

/** True if every edge has exactly two faces (closed 2-manifold surface). */
export function isClosedManifold(m: MeshData, topo = buildTopology(m)): boolean {
  if (m.faces.length === 0) return false;
  for (let e = 0; e < topo.edges.length; e++) if (topo.edgeFaces[e].length !== 2) return false;
  return true;
}

/** Euler characteristic V - E + F. */
export function eulerCharacteristic(m: MeshData, topo = buildTopology(m)): number {
  return vertexCount(m) - topo.edges.length + m.faces.length;
}

/**
 * Checks that faces sharing an edge traverse it in opposite directions (consistent winding).
 * Returns the number of edges with inconsistent orientation.
 */
export function countInconsistentEdges(m: MeshData): number {
  const directed = new Map<string, number>();
  for (const f of m.faces) {
    for (let i = 0; i < f.length; i++) {
      const k = `${f[i]}>${f[(i + 1) % f.length]}`;
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const n of directed.values()) if (n > 1) bad += n - 1;
  return bad;
}

/** Connected components of faces (via shared edges). Returns component id per face. */
export function faceIslands(m: MeshData, topo = buildTopology(m)): { islandOf: number[]; count: number } {
  const islandOf = new Array<number>(m.faces.length).fill(-1);
  let count = 0;
  for (let start = 0; start < m.faces.length; start++) {
    if (islandOf[start] >= 0) continue;
    const stack = [start];
    islandOf[start] = count;
    while (stack.length) {
      const f = stack.pop()!;
      for (const e of topo.faceEdges[f]) {
        for (const g of topo.edgeFaces[e]) {
          if (islandOf[g] < 0) {
            islandOf[g] = count;
            stack.push(g);
          }
        }
      }
    }
    count++;
  }
  return { islandOf, count };
}

/** Connected components of vertices (via edges). Returns component id per vertex. */
export function vertexIslands(m: MeshData, topo = buildTopology(m)): { islandOf: number[]; count: number } {
  const nv = vertexCount(m);
  const islandOf = new Array<number>(nv).fill(-1);
  let count = 0;
  for (let s = 0; s < nv; s++) {
    if (islandOf[s] >= 0) continue;
    const stack = [s];
    islandOf[s] = count;
    while (stack.length) {
      const v = stack.pop()!;
      for (const e of topo.vertEdges[v]) {
        const [a, b] = topo.edges[e];
        const w = a === v ? b : a;
        if (islandOf[w] < 0) {
          islandOf[w] = count;
          stack.push(w);
        }
      }
    }
    count++;
  }
  return { islandOf, count };
}
