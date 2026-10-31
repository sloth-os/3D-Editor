import type { Mat4, Vec3 } from '../../math/types';
import { normalMatrix4 } from '../../math/mat4';
import type { MeshData } from '../types';
import { edgeKey, vertexCount } from '../types';
import type { MeshSelection, SelectMode } from '../selection';
import {
  convertSelectMode,
  emptySelection,
  flushSelection,
  invertSelection,
  isSelectionEmpty,
  selectAllElements,
  selectionFromEdges,
  selectionFromFaces,
  selectionFromVerts,
} from '../selection';
import { buildTopology, vertexIslands, type Topology } from '../topology';
import { faceNormalRaw } from '../normals';
import { completeSelection, directedEdgeFaces, seededRandom, vertexFan } from './util';

/*
 * Edit-mode selection operations. They never modify the mesh; every function returns a new,
 * consistent selection (flushed for the given select mode where it matters).
 */

export type SelectAllAction = 'TOGGLE' | 'SELECT' | 'DESELECT' | 'INVERT';
export type SelectCombine = 'SET' | 'ADD' | 'SUB';

/** Union of two selections (all element types). */
export function unionSelection(a: MeshSelection, b: MeshSelection): MeshSelection {
  return {
    verts: new Set([...a.verts, ...b.verts]),
    edges: new Set([...a.edges, ...b.edges]),
    faces: new Set([...a.faces, ...b.faces]),
  };
}

/**
 * Combines the current selection with `delta` (SET replaces, ADD extends, SUB removes) using the
 * element type of the select mode, and returns the flushed result.
 */
export function combineSelection(
  m: MeshData,
  current: MeshSelection,
  delta: MeshSelection,
  op: SelectCombine,
  mode: SelectMode,
): MeshSelection {
  if (op === 'SET') return flushSelection(m, delta, mode);
  const cur = flushSelection(m, current, mode);
  if (op === 'ADD') return flushSelection(m, unionSelection(cur, delta), mode);
  if (mode === 'VERT')
    return selectionFromVerts(
      m,
      [...cur.verts].filter((v) => !delta.verts.has(v)),
    );
  if (mode === 'EDGE')
    return selectionFromEdges(
      m,
      [...cur.edges].filter((e) => !delta.edges.has(e)),
    );
  return selectionFromFaces(
    m,
    [...cur.faces].filter((f) => !delta.faces.has(f)),
  );
}

export function selectAll(
  m: MeshData,
  sel: MeshSelection,
  action: SelectAllAction,
  mode: SelectMode,
): MeshSelection {
  let a = action;
  if (a === 'TOGGLE') a = isSelectionEmpty(flushSelection(m, sel, mode)) ? 'SELECT' : 'DESELECT';
  if (a === 'SELECT') return selectAllElements(m);
  if (a === 'DESELECT') return emptySelection();
  return invertSelection(m, flushSelection(m, sel, mode), mode);
}

const MODE_ORDER: Record<SelectMode, number> = { VERT: 0, EDGE: 1, FACE: 2 };

/**
 * Converts the selection when switching select mode. With `expand`, switching to a "higher" mode
 * selects every edge/face touching the selection instead of only fully selected ones.
 */
export function changeSelectMode(
  m: MeshData,
  sel: MeshSelection,
  from: SelectMode,
  to: SelectMode,
  expand = false,
): MeshSelection {
  if (!expand || MODE_ORDER[to] <= MODE_ORDER[from]) return convertSelectMode(m, sel, from, to);
  const s = flushSelection(m, sel, from);
  const topo = buildTopology(m);
  if (to === 'EDGE') {
    const edges: string[] = [];
    for (const [a, b] of topo.edges) if (s.verts.has(a) || s.verts.has(b)) edges.push(edgeKey(a, b));
    return selectionFromEdges(m, edges, topo);
  }
  const faces: number[] = [];
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    let hit = false;
    for (let i = 0; i < face.length && !hit; i++)
      hit =
        from === 'VERT' ? s.verts.has(face[i]) : s.edges.has(edgeKey(face[i], face[(i + 1) % face.length]));
    if (hit) faces.push(f);
  }
  return selectionFromFaces(m, faces);
}

// ---------------------------------------------------------------------------------- explicit

export interface ElementRefs {
  verts?: readonly number[];
  edges?: readonly (readonly [number, number])[];
  faces?: readonly number[];
}

/** Validates element references and returns the explicitly referenced elements. Throws on bad input. */
function resolveRefs(
  m: MeshData,
  topo: Topology,
  refs: ElementRefs,
): { verts: number[]; edges: string[]; faces: number[] } {
  const nv = vertexCount(m);
  const verts = (refs.verts ?? []).map((v) => {
    if (!Number.isInteger(v) || v < 0 || v >= nv)
      throw new Error(`Vertex index ${v} out of range (mesh has ${nv} vertices)`);
    return v;
  });
  const edges = (refs.edges ?? []).map(([a, b]) => {
    const k = edgeKey(a, b);
    if (!topo.edgeIndex.has(k)) throw new Error(`Edge [${a}, ${b}] does not exist`);
    return k;
  });
  const faces = (refs.faces ?? []).map((f) => {
    if (!Number.isInteger(f) || f < 0 || f >= m.faces.length)
      throw new Error(`Face index ${f} out of range (mesh has ${m.faces.length} faces)`);
    return f;
  });
  return { verts, edges, faces };
}

/**
 * Selects (or deselects) explicitly given elements. Given vertices also select the edges/faces
 * they fully cover (so vertex lists work in any select mode). `extend` keeps the current selection.
 */
export function selectElements(
  m: MeshData,
  sel: MeshSelection,
  refs: ElementRefs,
  opts: { extend?: boolean; deselect?: boolean; mode: SelectMode },
): MeshSelection {
  const topo = buildTopology(m);
  const r = resolveRefs(m, topo, refs);
  const mode = opts.mode;
  if (opts.deselect) {
    const cur = flushSelection(m, sel, mode, topo);
    const vset = new Set(r.verts);
    const eset = new Set(r.edges);
    const fset = new Set(r.faces);
    if (mode === 'VERT') {
      const drop = new Set(vset);
      for (const k of eset) for (const v of k.split(',')) drop.add(Number(v));
      for (const f of fset) for (const v of m.faces[f]) drop.add(v);
      return selectionFromVerts(
        m,
        [...cur.verts].filter((v) => !drop.has(v)),
        topo,
      );
    }
    const touches = (a: number, b: number) => vset.has(a) || vset.has(b) || eset.has(edgeKey(a, b));
    if (mode === 'EDGE') {
      const drop = new Set(eset);
      for (const f of fset) {
        const face = m.faces[f];
        for (let i = 0; i < face.length; i++) drop.add(edgeKey(face[i], face[(i + 1) % face.length]));
      }
      for (const [a, b] of topo.edges) if (touches(a, b)) drop.add(edgeKey(a, b));
      return selectionFromEdges(
        m,
        [...cur.edges].filter((k) => !drop.has(k)),
        topo,
      );
    }
    const keep = [...cur.faces].filter((f) => {
      if (fset.has(f)) return false;
      const face = m.faces[f];
      for (let i = 0; i < face.length; i++) if (touches(face[i], face[(i + 1) % face.length])) return false;
      return true;
    });
    return selectionFromFaces(m, keep);
  }
  const delta = unionSelection(
    unionSelection(selectionFromVerts(m, r.verts, topo), selectionFromEdges(m, r.edges, topo)),
    selectionFromFaces(m, r.faces),
  );
  return combineSelection(m, sel, delta, opts.extend ? 'ADD' : 'SET', mode);
}

// ---------------------------------------------------------------------------------- linked / more / less

export type LinkedDelimit = 'SEAM' | 'SHARP' | 'MATERIAL' | 'NORMAL' | 'UV';

function traverses(face: readonly number[], a: number, b: number): boolean {
  const i = face.indexOf(a);
  return i >= 0 && face[(i + 1) % face.length] === b;
}

function cornerUVAt(m: MeshData, f: number, v: number): [number, number] | null {
  if (!m.uvs) return null;
  const i = m.faces[f].indexOf(v);
  const uv = m.uvs[f];
  return i >= 0 && uv ? [uv[i * 2], uv[i * 2 + 1]] : null;
}

/**
 * Selects everything connected to the current selection. With delimiters, connectivity is followed
 * through faces only and stops at seams / sharp edges / material changes / flipped normals / UV
 * discontinuities. Without delimiters, vertex connectivity (via any edge) is used.
 */
export function selectLinked(
  m: MeshData,
  sel: MeshSelection,
  mode: SelectMode,
  delimit: readonly LinkedDelimit[] = ['SEAM'],
): MeshSelection {
  const topo = buildTopology(m);
  const s = completeSelection(m, sel, topo);
  if (delimit.length === 0) {
    const { islandOf } = vertexIslands(m, topo);
    const islands = new Set<number>();
    for (const v of s.verts) islands.add(islandOf[v]);
    const verts: number[] = [];
    for (let v = 0; v < islandOf.length; v++) if (islands.has(islandOf[v])) verts.push(v);
    return selectionFromVerts(m, verts, topo);
  }
  const blocked = (e: number, f: number, g: number): boolean => {
    const [a, b] = topo.edges[e];
    const attr = m.edgeAttrs[edgeKey(a, b)];
    if (delimit.includes('SEAM') && attr?.seam) return true;
    if (delimit.includes('SHARP') && attr?.sharp) return true;
    if (delimit.includes('MATERIAL') && m.faceMaterials[f] !== m.faceMaterials[g]) return true;
    if (delimit.includes('NORMAL') && traverses(m.faces[f], a, b) === traverses(m.faces[g], a, b))
      return true;
    if (delimit.includes('UV') && m.uvs) {
      for (const v of [a, b]) {
        const p = cornerUVAt(m, f, v);
        const q = cornerUVAt(m, g, v);
        if (p && q && Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-5) return true;
      }
    }
    return false;
  };
  const reached = new Uint8Array(m.faces.length);
  const stack: number[] = [];
  const seed = (f: number) => {
    if (!reached[f]) {
      reached[f] = 1;
      stack.push(f);
    }
  };
  if (mode === 'FACE') for (const f of s.faces) seed(f);
  else for (const v of s.verts) for (const f of topo.vertFaces[v]) seed(f);
  while (stack.length) {
    const f = stack.pop()!;
    for (const e of topo.faceEdges[f]) {
      for (const g of topo.edgeFaces[e]) if (g !== f && !reached[g] && !blocked(e, f, g)) seed(g);
    }
  }
  const out = emptySelection();
  for (let f = 0; f < m.faces.length; f++) {
    if (!reached[f]) continue;
    out.faces.add(f);
    const face = m.faces[f];
    for (let i = 0; i < face.length; i++) {
      out.verts.add(face[i]);
      out.edges.add(edgeKey(face[i], face[(i + 1) % face.length]));
    }
  }
  // Wire geometry: walk loose edges from selected vertices.
  if (mode !== 'FACE') {
    const vstack = [...s.verts];
    const seen = new Set<number>(vstack);
    while (vstack.length) {
      const v = vstack.pop()!;
      out.verts.add(v);
      for (const e of topo.vertEdges[v]) {
        if (topo.edgeFaces[e].length > 0) continue;
        const [a, b] = topo.edges[e];
        out.edges.add(edgeKey(a, b));
        const w = a === v ? b : a;
        if (!seen.has(w)) {
          seen.add(w);
          vstack.push(w);
        }
      }
    }
  }
  return out;
}

/** Grows the selection by one step (`useFaceStep`: across faces instead of edges). */
export function selectMore(
  m: MeshData,
  sel: MeshSelection,
  mode: SelectMode,
  useFaceStep = true,
): MeshSelection {
  const topo = buildTopology(m);
  const s = flushSelection(m, completeSelection(m, sel, topo), mode, topo);
  if (mode === 'FACE') {
    const faces = new Set(s.faces);
    for (const f of s.faces) {
      if (useFaceStep) for (const v of m.faces[f]) for (const g of topo.vertFaces[v]) faces.add(g);
      else for (const e of topo.faceEdges[f]) for (const g of topo.edgeFaces[e]) faces.add(g);
    }
    return selectionFromFaces(m, faces);
  }
  const verts = new Set(s.verts);
  for (const v of s.verts) {
    for (const e of topo.vertEdges[v]) {
      const [a, b] = topo.edges[e];
      verts.add(a);
      verts.add(b);
    }
    if (useFaceStep) for (const f of topo.vertFaces[v]) for (const w of m.faces[f]) verts.add(w);
  }
  return selectionFromVerts(m, verts, topo);
}

/** Shrinks the selection by one step (elements on the border of the selection are deselected). */
export function selectLess(
  m: MeshData,
  sel: MeshSelection,
  mode: SelectMode,
  useFaceStep = true,
): MeshSelection {
  const topo = buildTopology(m);
  const s = flushSelection(m, completeSelection(m, sel, topo), mode, topo);
  if (mode === 'FACE') {
    const keep = [...s.faces].filter((f) => {
      if (useFaceStep) return m.faces[f].every((v) => topo.vertFaces[v].every((g) => s.faces.has(g)));
      return topo.faceEdges[f].every((e) => topo.edgeFaces[e].every((g) => s.faces.has(g)));
    });
    return selectionFromFaces(m, keep);
  }
  const keep = [...s.verts].filter((v) => {
    for (const e of topo.vertEdges[v]) {
      const [a, b] = topo.edges[e];
      if (!s.verts.has(a === v ? b : a)) return false;
    }
    if (useFaceStep)
      for (const f of topo.vertFaces[v]) if (!m.faces[f].every((w) => s.verts.has(w))) return false;
    return true;
  });
  return selectionFromVerts(m, keep, topo);
}

// ---------------------------------------------------------------------------------- loops and rings

/**
 * Edge loop through edge `start` (index into topo.edges). Interior loops continue straight through
 * valence-4 vertices; boundary edges follow the mesh boundary; wire edges follow wire chains.
 * Returns the edge indices in walking order.
 */
export function edgeLoop(m: MeshData, topo: Topology, start: number): number[] {
  const kind = Math.min(topo.edgeFaces[start].length, 2);
  const seen = new Set<number>([start]);
  const step = (e: number, v: number): number => {
    const cand = topo.vertEdges[v].filter((x) => x !== e);
    if (kind < 2) {
      const same = cand.filter((x) => topo.edgeFaces[x].length === kind);
      return same.length === 1 ? same[0] : -1;
    }
    if (topo.edgeFaces[e].length !== 2 || topo.vertEdges[v].length !== 4) return -1;
    if (topo.vertEdges[v].some((x) => topo.edgeFaces[x].length !== 2)) return -1;
    const ef = topo.edgeFaces[e];
    const opp = cand.filter((x) => !topo.edgeFaces[x].some((f) => ef.includes(f)));
    return opp.length === 1 ? opp[0] : -1;
  };
  const walk = (from: number, out: number[]): boolean => {
    let e = start;
    let v = from;
    for (;;) {
      const n = step(e, v);
      if (n < 0) return false;
      if (n === start) return true;
      if (seen.has(n)) return false;
      seen.add(n);
      out.push(n);
      const [a, b] = topo.edges[n];
      v = a === v ? b : a;
      e = n;
    }
  };
  const [a, b] = topo.edges[start];
  const fwd: number[] = [];
  const bwd: number[] = [];
  if (!walk(b, fwd)) walk(a, bwd);
  return [...bwd.reverse(), start, ...fwd];
}

/**
 * Edge ring through edge `start`: crosses quads to their opposite edge. Returns the ring edges
 * and the quads crossed (the "face loop").
 */
export function edgeRing(
  m: MeshData,
  topo: Topology,
  start: number,
): { edges: number[]; faces: number[]; closed: boolean } {
  const seenE = new Set<number>([start]);
  const seenF = new Set<number>();
  const walk = (f0: number, outE: number[], outF: number[]): boolean => {
    let e = start;
    let f = f0;
    for (;;) {
      if (m.faces[f].length !== 4 || seenF.has(f)) return false;
      seenF.add(f);
      outF.push(f);
      const fe = topo.faceEdges[f];
      const opp = fe[(fe.indexOf(e) + 2) % 4];
      if (opp === start) return true;
      if (seenE.has(opp)) return false;
      seenE.add(opp);
      outE.push(opp);
      const ef = topo.edgeFaces[opp];
      if (ef.length !== 2) return false;
      e = opp;
      f = ef[0] === f ? ef[1] : ef[0];
    }
  };
  const ef = topo.edgeFaces[start];
  const fwdE: number[] = [];
  const fwdF: number[] = [];
  const bwdE: number[] = [];
  const bwdF: number[] = [];
  let closed = false;
  if (ef.length >= 1 && ef.length <= 2) {
    closed = walk(ef[0], fwdE, fwdF);
    if (!closed && ef.length === 2) walk(ef[1], bwdE, bwdF);
  }
  return { edges: [...bwdE.reverse(), start, ...fwdE], faces: [...bwdF.reverse(), ...fwdF], closed };
}

export interface LoopSelectOptions {
  ring?: boolean;
  extend?: boolean;
  deselect?: boolean;
  toggle?: boolean;
  mode: SelectMode;
}

/**
 * Selects the edge loop (or ring with `ring`) through the edge [a, b]. In face select mode the
 * face loop crossed by the edge ring is selected (like Alt+click in Blender).
 */
export function loopSelect(
  m: MeshData,
  sel: MeshSelection,
  edge: readonly [number, number],
  opts: LoopSelectOptions,
): MeshSelection {
  const topo = buildTopology(m);
  const k = edgeKey(edge[0], edge[1]);
  const e0 = topo.edgeIndex.get(k);
  if (e0 === undefined) throw new Error(`Edge [${edge[0]}, ${edge[1]}] does not exist`);
  let delta: MeshSelection;
  if (opts.mode === 'FACE') delta = selectionFromFaces(m, edgeRing(m, topo, e0).faces);
  else {
    const edges = opts.ring ? edgeRing(m, topo, e0).edges : edgeLoop(m, topo, e0);
    delta = selectionFromEdges(
      m,
      edges.map((e) => edgeKey(topo.edges[e][0], topo.edges[e][1])),
      topo,
    );
  }
  let op: SelectCombine = opts.extend ? 'ADD' : 'SET';
  if (opts.deselect) op = 'SUB';
  else if (opts.toggle) {
    const cur = flushSelection(m, sel, opts.mode, topo);
    const isSel =
      opts.mode === 'FACE'
        ? [...delta.faces].every((f) => cur.faces.has(f)) && delta.faces.size > 0
        : cur.edges.has(k);
    op = isSel ? 'SUB' : 'ADD';
  }
  return combineSelection(m, sel, delta, op, opts.mode);
}

// ---------------------------------------------------------------------------------- special selections

export interface NonManifoldOptions {
  wire?: boolean;
  boundary?: boolean;
  multiFace?: boolean;
  nonContiguous?: boolean;
  verts?: boolean;
}

/** Selects non-manifold geometry (wire / boundary / >2-face edges, flipped neighbours, bow-tie vertices). */
export function selectNonManifold(
  m: MeshData,
  sel: MeshSelection,
  opts: NonManifoldOptions = {},
  extend = true,
): MeshSelection {
  const o = { wire: true, boundary: true, multiFace: true, nonContiguous: true, verts: true, ...opts };
  const topo = buildTopology(m);
  const delta = emptySelection();
  for (let e = 0; e < topo.edges.length; e++) {
    const ef = topo.edgeFaces[e];
    const [a, b] = topo.edges[e];
    let hit: boolean;
    if (ef.length === 0) hit = o.wire;
    else if (ef.length === 1) hit = o.boundary;
    else if (ef.length > 2) hit = o.multiFace;
    else hit = o.nonContiguous && traverses(m.faces[ef[0]], a, b) === traverses(m.faces[ef[1]], a, b);
    if (hit) {
      delta.edges.add(edgeKey(a, b));
      delta.verts.add(a);
      delta.verts.add(b);
    }
  }
  if (o.verts) {
    const dmap = directedEdgeFaces(m);
    for (let v = 0; v < vertexCount(m); v++) {
      if (topo.vertEdges[v].length === 0) delta.verts.add(v);
      else if (topo.vertFaces[v].length > 0 && !vertexFan(m, v, topo.vertFaces[v], dmap)) delta.verts.add(v);
    }
  }
  return extend ? unionSelection(completeSelection(m, sel, topo), delta) : delta;
}

/** Selects loose geometry: vertices without edges, edges without faces and faces without neighbours. */
export function selectLoose(m: MeshData, sel: MeshSelection, extend = false): MeshSelection {
  const topo = buildTopology(m);
  const delta = emptySelection();
  for (let v = 0; v < vertexCount(m); v++) if (topo.vertEdges[v].length === 0) delta.verts.add(v);
  for (let e = 0; e < topo.edges.length; e++) {
    if (topo.edgeFaces[e].length > 0) continue;
    const [a, b] = topo.edges[e];
    delta.edges.add(edgeKey(a, b));
    delta.verts.add(a);
    delta.verts.add(b);
  }
  const looseFaces: number[] = [];
  for (let f = 0; f < m.faces.length; f++)
    if (topo.faceEdges[f].every((e) => topo.edgeFaces[e].length === 1)) looseFaces.push(f);
  const out = unionSelection(delta, selectionFromFaces(m, looseFaces));
  return extend ? unionSelection(completeSelection(m, sel, topo), out) : out;
}

/** Randomly (but deterministically for a seed) selects or deselects elements of the select mode. */
export function selectRandom(
  m: MeshData,
  sel: MeshSelection,
  opts: { ratio: number; seed: number; action: 'SELECT' | 'DESELECT'; mode: SelectMode },
): MeshSelection {
  const rnd = seededRandom(opts.seed);
  const delta = emptySelection();
  if (opts.mode === 'VERT') {
    for (let v = 0; v < vertexCount(m); v++) if (rnd() < opts.ratio) delta.verts.add(v);
  } else if (opts.mode === 'EDGE') {
    const topo = buildTopology(m);
    const keys: string[] = [];
    for (const [a, b] of topo.edges) if (rnd() < opts.ratio) keys.push(edgeKey(a, b));
    Object.assign(delta, selectionFromEdges(m, keys, topo));
  } else {
    const faces: number[] = [];
    for (let f = 0; f < m.faces.length; f++) if (rnd() < opts.ratio) faces.push(f);
    Object.assign(delta, selectionFromFaces(m, faces));
  }
  return combineSelection(m, sel, delta, opts.action === 'SELECT' ? 'ADD' : 'SUB', opts.mode);
}

/**
 * Selects faces whose normal is within `angle` radians of `direction`. When `matrix` (object world
 * matrix) is given, normals are compared in world space and `direction` is a world direction.
 */
export function selectByNormal(
  m: MeshData,
  sel: MeshSelection,
  opts: {
    direction: Readonly<Vec3>;
    angle: number;
    extend?: boolean;
    mode: SelectMode;
    matrix?: Readonly<Mat4>;
  },
): MeshSelection {
  const d = opts.direction;
  const dl = Math.hypot(d[0], d[1], d[2]);
  if (dl < 1e-12) throw new Error('direction must not be zero');
  const nm = opts.matrix ? normalMatrix4(opts.matrix) : null;
  const cos = Math.cos(Math.max(0, opts.angle));
  const faces: number[] = [];
  for (let f = 0; f < m.faces.length; f++) {
    let n = faceNormalRaw(m, f);
    if (nm)
      n = [
        nm[0] * n[0] + nm[4] * n[1] + nm[8] * n[2],
        nm[1] * n[0] + nm[5] * n[1] + nm[9] * n[2],
        nm[2] * n[0] + nm[6] * n[1] + nm[10] * n[2],
      ];
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-14) continue;
    if ((n[0] * d[0] + n[1] * d[1] + n[2] * d[2]) / (l * dl) >= cos - 1e-9) faces.push(f);
  }
  return combineSelection(m, sel, selectionFromFaces(m, faces), opts.extend ? 'ADD' : 'SET', opts.mode);
}
