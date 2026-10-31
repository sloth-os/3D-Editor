import type { MeshData } from './types';
import { edgeKey, parseEdgeKey, vertexCount } from './types';
import { buildTopology, type Topology } from './topology';

export type SelectMode = 'VERT' | 'EDGE' | 'FACE';

/**
 * Edit-mode selection. This is local (per device / per agent) state and is never stored in the
 * shared document. Edges are identified by `edgeKey(a, b)`.
 */
export interface MeshSelection {
  verts: Set<number>;
  edges: Set<string>;
  faces: Set<number>;
}

export function emptySelection(): MeshSelection {
  return { verts: new Set(), edges: new Set(), faces: new Set() };
}

export function cloneSelection(s: MeshSelection): MeshSelection {
  return { verts: new Set(s.verts), edges: new Set(s.edges), faces: new Set(s.faces) };
}

export function isSelectionEmpty(s: MeshSelection): boolean {
  return s.verts.size === 0 && s.edges.size === 0 && s.faces.size === 0;
}

export function selectAllElements(m: MeshData): MeshSelection {
  const sel = emptySelection();
  const n = vertexCount(m);
  for (let i = 0; i < n; i++) sel.verts.add(i);
  for (let f = 0; f < m.faces.length; f++) {
    sel.faces.add(f);
    const face = m.faces[f];
    for (let i = 0; i < face.length; i++) sel.edges.add(edgeKey(face[i], face[(i + 1) % face.length]));
  }
  for (let i = 0; i < m.looseEdges.length; i += 2)
    sel.edges.add(edgeKey(m.looseEdges[i], m.looseEdges[i + 1]));
  return sel;
}

/** Builds a fully consistent selection from selected vertices (vertex select mode rules). */
export function selectionFromVerts(m: MeshData, verts: Iterable<number>, topo?: Topology): MeshSelection {
  const t = topo ?? buildTopology(m);
  const sel = emptySelection();
  for (const v of verts) sel.verts.add(v);
  for (const [a, b] of t.edges) if (sel.verts.has(a) && sel.verts.has(b)) sel.edges.add(edgeKey(a, b));
  for (let f = 0; f < m.faces.length; f++) if (m.faces[f].every((v) => sel.verts.has(v))) sel.faces.add(f);
  return sel;
}

/** Builds a consistent selection from selected edges (edge select mode rules). */
export function selectionFromEdges(m: MeshData, edges: Iterable<string>, topo?: Topology): MeshSelection {
  const t = topo ?? buildTopology(m);
  const sel = emptySelection();
  for (const k of edges) {
    if (!t.edgeIndex.has(k)) continue;
    sel.edges.add(k);
    const [a, b] = parseEdgeKey(k);
    sel.verts.add(a);
    sel.verts.add(b);
  }
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    let all = true;
    for (let i = 0; i < face.length && all; i++)
      all = sel.edges.has(edgeKey(face[i], face[(i + 1) % face.length]));
    if (all) sel.faces.add(f);
  }
  return sel;
}

/** Builds a consistent selection from selected faces (face select mode rules). */
export function selectionFromFaces(m: MeshData, faces: Iterable<number>): MeshSelection {
  const sel = emptySelection();
  for (const f of faces) {
    const face = m.faces[f];
    if (!face) continue;
    sel.faces.add(f);
    for (let i = 0; i < face.length; i++) {
      sel.verts.add(face[i]);
      sel.edges.add(edgeKey(face[i], face[(i + 1) % face.length]));
    }
  }
  return sel;
}

/**
 * Re-derives a consistent selection according to the select mode, using the primary element
 * type of that mode as the source of truth. Also drops indices that no longer exist.
 */
export function flushSelection(
  m: MeshData,
  sel: MeshSelection,
  mode: SelectMode,
  topo?: Topology,
): MeshSelection {
  const nv = vertexCount(m);
  if (mode === 'VERT')
    return selectionFromVerts(
      m,
      [...sel.verts].filter((v) => v >= 0 && v < nv),
      topo,
    );
  if (mode === 'EDGE') return selectionFromEdges(m, sel.edges, topo);
  return selectionFromFaces(
    m,
    [...sel.faces].filter((f) => f >= 0 && f < m.faces.length),
  );
}

/** Converts a selection when switching select modes (Blender behavior). */
export function convertSelectMode(
  m: MeshData,
  sel: MeshSelection,
  from: SelectMode,
  to: SelectMode,
): MeshSelection {
  if (from === to) return flushSelection(m, sel, to);
  if (to === 'VERT') return selectionFromVerts(m, sel.verts);
  if (to === 'EDGE') return selectionFromEdges(m, flushSelection(m, sel, from).edges);
  return selectionFromFaces(m, flushSelection(m, sel, from).faces);
}

/** Selected vertex indices implied by the selection (union of all element types). */
export function selectedVertexSet(m: MeshData, sel: MeshSelection): Set<number> {
  const out = new Set(sel.verts);
  for (const k of sel.edges) {
    const [a, b] = parseEdgeKey(k);
    out.add(a);
    out.add(b);
  }
  for (const f of sel.faces) for (const v of m.faces[f] ?? []) out.add(v);
  return out;
}

/** Inverts the selection within the given mode. */
export function invertSelection(m: MeshData, sel: MeshSelection, mode: SelectMode): MeshSelection {
  if (mode === 'VERT') {
    const verts: number[] = [];
    for (let i = 0; i < vertexCount(m); i++) if (!sel.verts.has(i)) verts.push(i);
    return selectionFromVerts(m, verts);
  }
  if (mode === 'EDGE') {
    const t = buildTopology(m);
    const edges: string[] = [];
    for (const [a, b] of t.edges) {
      const k = edgeKey(a, b);
      if (!sel.edges.has(k)) edges.push(k);
    }
    return selectionFromEdges(m, edges, t);
  }
  const faces: number[] = [];
  for (let f = 0; f < m.faces.length; f++) if (!sel.faces.has(f)) faces.push(f);
  return selectionFromFaces(m, faces);
}

/** Serializable form of a selection (for undo metadata, awareness and MCP). */
export interface SelectionJSON {
  verts: number[];
  edges: [number, number][];
  faces: number[];
}

export function selectionToJSON(s: MeshSelection): SelectionJSON {
  return {
    verts: [...s.verts].sort((a, b) => a - b),
    edges: [...s.edges].map(parseEdgeKey),
    faces: [...s.faces].sort((a, b) => a - b),
  };
}

export function selectionFromJSON(j: Partial<SelectionJSON>): MeshSelection {
  return {
    verts: new Set(j.verts ?? []),
    edges: new Set((j.edges ?? []).map(([a, b]) => edgeKey(a, b))),
    faces: new Set(j.faces ?? []),
  };
}
