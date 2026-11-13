import type { Vec3 } from '../../math/types';
import type { MeshData } from '../types';
import { cloneMesh, pruneEdgeData } from '../types';
import type { MeshSelection } from '../selection';
import { selectionFromFaces, selectionFromVerts } from '../selection';
import { buildTopology, type Topology } from '../topology';
import { computeVertexNormals, faceNormal } from '../normals';
import type { MeshOpResult } from './types';
import {
  addVertexFrom,
  allFaceRecs,
  completeSelection,
  copyEdgeAttr,
  type FaceRec,
  makeFace,
  pushTo,
  removeUnusedAmong,
  requireNonEmpty,
  UnionFind,
  uvOf,
  vpos,
  writeFaces,
} from './util';

/*
 * Extrusion (Blender E key family). New geometry is created for the selection; the original
 * geometry stays connected to the unselected part of the mesh through side walls, so closed meshes
 * stay closed and consistently wound.
 */

export interface ExtrudeOptions {
  /** Local-space translation applied to the extruded vertices. */
  offset?: Readonly<Vec3>;
  /** Distance along the vertex normals of the extruded region (shrink/fatten). */
  normalOffset?: number;
  /** With `normalOffset`: keep the thickness even at corners (shell factor). */
  evenOffset?: boolean;
}

interface CoreInput {
  regionFaces: Uint8Array;
  /** Edge indices extruded as single edges (they become quads). */
  edges: number[];
  /** Vertex indices extruded as single vertices (they become wire edges). */
  verts: number[];
}

function extrudeCore(
  src: MeshData,
  topo: Topology,
  input: CoreInput,
  opts: ExtrudeOptions,
): MeshOpResult & { newVerts: number[] } {
  const m = cloneMesh(src);
  const recs = allFaceRecs(src);
  const inR = input.regionFaces;
  const regionCount = new Int32Array(topo.edges.length);
  for (let f = 0; f < src.faces.length; f++) if (inR[f]) for (const e of topo.faceEdges[f]) regionCount[e]++;

  // Region corners of the same vertex connected through interior region edges form a fan; every
  // fan gets its own duplicate, so regions touching at a single vertex stay manifold.
  const slotBase = new Int32Array(src.faces.length).fill(-1);
  let nslots = 0;
  for (let f = 0; f < src.faces.length; f++)
    if (inR[f]) {
      slotBase[f] = nslots;
      nslots += src.faces[f].length;
    }
  const uf = new UnionFind(nslots);
  for (let f = 0; f < src.faces.length; f++) {
    if (!inR[f]) continue;
    const face = src.faces[f];
    for (let i = 0; i < face.length; i++) {
      const e = topo.faceEdges[f][i];
      if (regionCount[e] !== 2) continue;
      const g = topo.edgeFaces[e].find((x) => x !== f && inR[x]);
      if (g === undefined) continue;
      uf.union(slotBase[f] + i, slotBase[g] + src.faces[g].indexOf(face[i]));
      uf.union(
        slotBase[f] + ((i + 1) % face.length),
        slotBase[g] + src.faces[g].indexOf(face[(i + 1) % face.length]),
      );
    }
  }
  const newVerts: number[] = [];
  const origin = new Map<number, number>(); // duplicate → original vertex
  const fanFaces = new Map<number, number[]>(); // duplicate → region faces around it
  const anyDup = new Map<number, number>(); // original vertex → a duplicate of it
  const makeDup = (v: number): number => {
    const d = addVertexFrom(m, vpos(src, v), [v]);
    newVerts.push(d);
    origin.set(d, v);
    if (!anyDup.has(v)) anyDup.set(v, d);
    return d;
  };
  const fanDup = new Map<number, number>();
  const dupFace = new Map<number, number[]>();
  const regionVerts = new Set<number>();
  for (let f = 0; f < src.faces.length; f++) {
    if (!inR[f]) continue;
    dupFace.set(
      f,
      src.faces[f].map((v, i) => {
        regionVerts.add(v);
        const root = uf.find(slotBase[f] + i);
        let d = fanDup.get(root);
        if (d === undefined) fanDup.set(root, (d = makeDup(v)));
        pushTo(fanFaces, d, f);
        return d;
      }),
    );
  }
  const dupOf = (v: number): number => anyDup.get(v) ?? makeDup(v);

  const out: FaceRec[] = recs.slice();
  const walls: FaceRec[] = [];
  for (const [f, dv] of dupFace) {
    const rec = recs[f];
    const face = src.faces[f];
    const n = face.length;
    for (let i = 0; i < n; i++) {
      const e = topo.faceEdges[f][i];
      if (regionCount[e] !== 1) continue;
      const j = (i + 1) % n;
      const a = face[i];
      const b = face[j];
      const ua = uvOf(rec, i);
      const ub = uvOf(rec, j);
      let oa = ua;
      let ob = ub;
      const g = topo.edgeFaces[e].find((x) => !inR[x]);
      if (g !== undefined && src.uvs) {
        oa = uvOf(recs[g], src.faces[g].indexOf(a));
        ob = uvOf(recs[g], src.faces[g].indexOf(b));
      }
      // The region face now runs a'→b', the outside face b→a: the wall runs a→b→b'→a'.
      walls.push(makeFace(m, [a, b, dv[j], dv[i]], rec, [...oa, ...ob, ...ub, ...ua]));
      copyEdgeAttr(m, a, b, dv[i], dv[j]);
    }
    out[f] = { ...rec, v: dv, sel: true };
  }

  for (const e of input.edges) {
    const [a, b] = topo.edges[e];
    const ef = topo.edgeFaces[e];
    let like: FaceRec | null = null;
    let loop: number[];
    let uv: number[] | null = null;
    if (ef.length > 0) {
      const g = ef[0];
      like = recs[g];
      const face = src.faces[g];
      const ia = face.indexOf(a);
      const ib = face.indexOf(b);
      const ua = uvOf(recs[g], ia);
      const ub = uvOf(recs[g], ib);
      if (face[(ia + 1) % face.length] === b) {
        loop = [b, a, dupOf(a), dupOf(b)];
        uv = [...ub, ...ua, ...ua, ...ub];
      } else {
        loop = [a, b, dupOf(b), dupOf(a)];
        uv = [...ua, ...ub, ...ub, ...ua];
      }
    } else loop = [a, b, dupOf(b), dupOf(a)];
    walls.push(makeFace(m, loop, like, uv));
    copyEdgeAttr(m, a, b, dupOf(a), dupOf(b));
  }

  for (const v of input.verts) m.looseEdges.push(v, dupOf(v));

  // Move the new vertices: translation plus an optional offset along the region normals.
  const off = opts.offset ?? [0, 0, 0];
  const dist = opts.normalOffset ?? 0;
  const faceN = new Map<number, Vec3>();
  const normalOfFace = (f: number): Vec3 => {
    let n = faceN.get(f);
    if (!n) faceN.set(f, (n = faceNormal(src, f)));
    return n;
  };
  const vnormals =
    dist !== 0 && (input.edges.length || input.verts.length) ? computeVertexNormals(src) : null;
  for (const d of newVerts) {
    const v = origin.get(d)!;
    let n: Vec3 = [0, 0, 0];
    const fans = fanFaces.get(d);
    if (dist !== 0 && fans) {
      for (const f of fans) {
        const nf = normalOfFace(f);
        n = [n[0] + nf[0], n[1] + nf[1], n[2] + nf[2]];
      }
      const l = Math.hypot(n[0], n[1], n[2]);
      n = l > 1e-12 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 0];
      if (opts.evenOffset && l > 1e-12) {
        let sum = 0;
        for (const f of fans) {
          const nf = normalOfFace(f);
          sum += n[0] * nf[0] + n[1] * nf[1] + n[2] * nf[2];
        }
        const k = 1 / Math.max(0.25, sum / fans.length);
        n = [n[0] * k, n[1] * k, n[2] * k];
      }
    } else if (vnormals) n = [vnormals[v * 3], vnormals[v * 3 + 1], vnormals[v * 3 + 2]];
    m.positions[d * 3] = src.positions[v * 3] + off[0] + n[0] * dist;
    m.positions[d * 3 + 1] = src.positions[v * 3 + 1] + off[1] + n[1] * dist;
    m.positions[d * 3 + 2] = src.positions[v * 3 + 2] + off[2] + n[2] * dist;
  }

  writeFaces(m, [...out, ...walls]);
  const remap = removeUnusedAmong(m, regionVerts);
  pruneEdgeData(m);
  const sel = selectionFromVerts(
    m,
    newVerts.map((v) => remap[v]).filter((v) => v >= 0),
  );
  return { mesh: m, selection: sel, newVerts: [...sel.verts] };
}

/**
 * Extrudes the selection like Blender's "Extrude Region": selected faces are extruded as one
 * connected region (side walls only along the region boundary), selected edges that are not part
 * of selected faces become quads, and lone selected vertices become wire edges.
 * The new geometry is selected.
 */
export function extrudeRegion(src: MeshData, sel: MeshSelection, opts: ExtrudeOptions = {}): MeshOpResult {
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  const regionFaces = new Uint8Array(src.faces.length);
  for (const f of s.faces) regionFaces[f] = 1;
  const edges: number[] = [];
  const edgeVerts = new Set<number>();
  for (const k of s.edges) {
    const e = topo.edgeIndex.get(k)!;
    const [a, b] = topo.edges[e];
    edgeVerts.add(a);
    edgeVerts.add(b);
    if (!topo.edgeFaces[e].some((f) => regionFaces[f])) edges.push(e);
  }
  const verts = [...s.verts].filter((v) => !edgeVerts.has(v));
  requireNonEmpty(s.faces.size + edges.length + verts.length, 'geometry');
  const { mesh, selection } = extrudeCore(src, topo, { regionFaces, edges, verts }, opts);
  return { mesh, selection };
}

/** Extrudes only the selected edges (each becomes a quad), ignoring faces. */
export function extrudeEdgesOnly(src: MeshData, sel: MeshSelection, opts: ExtrudeOptions = {}): MeshOpResult {
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  const edges = [...s.edges].map((k) => topo.edgeIndex.get(k)!).sort((a, b) => a - b);
  requireNonEmpty(edges.length, 'edges');
  const { mesh, selection } = extrudeCore(
    src,
    topo,
    { regionFaces: new Uint8Array(src.faces.length), edges, verts: [] },
    opts,
  );
  return { mesh, selection };
}

/** Extrudes only the selected vertices (each gets a new vertex connected by a wire edge). */
export function extrudeVerticesOnly(
  src: MeshData,
  sel: MeshSelection,
  opts: ExtrudeOptions = {},
): MeshOpResult {
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  const verts = [...s.verts].sort((a, b) => a - b);
  requireNonEmpty(verts.length, 'vertices');
  const { mesh, selection } = extrudeCore(
    src,
    topo,
    { regionFaces: new Uint8Array(src.faces.length), edges: [], verts },
    opts,
  );
  return { mesh, selection };
}

/**
 * Extrudes every selected face on its own (Blender "Extrude Individual Faces"): each face gets
 * its own copy moved `distance` along its normal plus side walls on all of its edges.
 */
export function extrudeIndividualFaces(src: MeshData, sel: MeshSelection, distance: number): MeshOpResult {
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  const faces = [...s.faces].sort((a, b) => a - b);
  requireNonEmpty(faces.length, 'faces');
  const m = cloneMesh(src);
  const recs = allFaceRecs(src);
  const out: FaceRec[] = recs.slice();
  const walls: FaceRec[] = [];
  const touched = new Set<number>();
  for (const f of faces) {
    const rec = recs[f];
    const face = src.faces[f];
    const n = face.length;
    const nrm = faceNormal(src, f);
    const copy = face.map((v) => {
      touched.add(v);
      const p = vpos(src, v);
      return addVertexFrom(
        m,
        [p[0] + nrm[0] * distance, p[1] + nrm[1] * distance, p[2] + nrm[2] * distance],
        [v],
      );
    });
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = face[i];
      const b = face[j];
      const ua = uvOf(rec, i);
      const ub = uvOf(rec, j);
      let oa = ua;
      let ob = ub;
      const g = topo.edgeFaces[topo.faceEdges[f][i]].find((x) => x !== f && !s.faces.has(x));
      if (g !== undefined && src.uvs) {
        oa = uvOf(recs[g], src.faces[g].indexOf(a));
        ob = uvOf(recs[g], src.faces[g].indexOf(b));
      }
      walls.push(makeFace(m, [a, b, copy[j], copy[i]], rec, [...oa, ...ob, ...ub, ...ua]));
      copyEdgeAttr(m, a, b, copy[i], copy[j]);
    }
    out[f] = { ...rec, v: copy, sel: true };
  }
  const selected = writeFaces(m, [...out, ...walls]);
  removeUnusedAmong(m, touched);
  pruneEdgeData(m);
  return { mesh: m, selection: selectionFromFaces(m, selected) };
}
