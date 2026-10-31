import type { Vec3 } from '../../math/types';
import type { MeshData } from '../types';
import { cloneMesh, pruneEdgeData } from '../types';
import type { MeshSelection } from '../selection';
import { selectionFromFaces } from '../selection';
import { buildTopology } from '../topology';
import type { MeshOpResult } from './types';
import {
  addVertexFrom,
  allFaceRecs,
  completeSelection,
  type FaceRec,
  makeFace,
  polygonNormal,
  requireNonEmpty,
  setVpos,
  UnionFind,
  uvFrame,
  uvOf,
  vpos,
  writeFaces,
} from './util';

export interface InsetOptions {
  /** Inset distance measured inside the faces (object local units). */
  thickness: number;
  /** Distance the inset faces are raised along their normals (negative pushes them in). */
  depth?: number;
  /** Inset every face on its own instead of the selected region as a whole. */
  individual?: boolean;
  /** Keep the inset distance even at sharp corners (miter scaling). Default true. */
  evenOffset?: boolean;
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-14 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
}

function cross(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** In-plane inward unit normal of the directed edge p→q of a face with unit normal n. */
export function inwardEdgeNormal(n: Readonly<Vec3>, p: Readonly<Vec3>, q: Readonly<Vec3>): Vec3 {
  return normalize(cross(n, normalize([q[0] - p[0], q[1] - p[1], q[2] - p[2]])));
}

/**
 * Offset direction for a corner whose adjacent edges have inward normals n1, n2. With `even`
 * the result has the length needed to stay `1` away from both edges (clamped at very sharp angles).
 */
export function miterDirection(n1: Readonly<Vec3>, n2: Readonly<Vec3>, even: boolean): Vec3 {
  const s: Vec3 = [n1[0] + n2[0], n1[1] + n2[1], n2[2] + n1[2]];
  const l = Math.hypot(s[0], s[1], s[2]);
  if (l < 1e-9) return [n1[0], n1[1], n1[2]];
  if (!even) return [s[0] / l, s[1] / l, s[2] / l];
  const k = Math.min(1 / (1 + n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]), 4 / l);
  return [s[0] * k, s[1] * k, s[2] * k];
}

/**
 * Inset faces (Blender I key). Region mode insets the outline of each connected group of
 * selected faces; individual mode insets every face separately. New faces are added between the
 * old outline and the inset faces; the inset faces stay selected.
 */
export function insetFaces(src: MeshData, sel: MeshSelection, opts: InsetOptions): MeshOpResult {
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  const faces = [...s.faces].sort((a, b) => a - b);
  requireNonEmpty(faces.length, 'faces');
  const even = opts.evenOffset ?? true;
  const depth = opts.depth ?? 0;
  const t = opts.thickness;
  const m = cloneMesh(src);
  const recs = allFaceRecs(src);
  const out: FaceRec[] = recs.slice();
  const walls: FaceRec[] = [];
  const normals = new Map<number, Vec3>();
  for (const f of faces) normals.set(f, normalize(polygonNormal(src.faces[f].map((v) => vpos(src, v)))));

  if (opts.individual) {
    for (const f of faces) {
      const rec = recs[f];
      const face = src.faces[f];
      const n = face.length;
      const nrm = normals.get(f)!;
      const frame = uvFrame(src, rec);
      const pts = face.map((v) => vpos(src, v));
      const inner: number[] = [];
      const innerUV: number[] = [];
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const n1 = inwardEdgeNormal(nrm, pts[(i + n - 1) % n], p);
        const n2 = inwardEdgeNormal(nrm, p, pts[(i + 1) % n]);
        const d = miterDirection(n1, n2, even);
        const q: Vec3 = [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];
        innerUV.push(...(frame ? frame.at(q, i) : uvOf(rec, i)));
        inner.push(
          addVertexFrom(m, [q[0] + nrm[0] * depth, q[1] + nrm[1] * depth, q[2] + nrm[2] * depth], [face[i]]),
        );
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        walls.push(
          makeFace(m, [face[i], face[j], inner[j], inner[i]], rec, [
            ...uvOf(rec, i),
            ...uvOf(rec, j),
            innerUV[j * 2],
            innerUV[j * 2 + 1],
            innerUV[i * 2],
            innerUV[i * 2 + 1],
          ]),
        );
      }
      out[f] = { ...rec, v: inner, uv: rec.uv ? innerUV : null, sel: true };
    }
  } else {
    const inR = new Uint8Array(src.faces.length);
    for (const f of faces) inR[f] = 1;
    const regionCount = new Int32Array(topo.edges.length);
    for (const f of faces) for (const e of topo.faceEdges[f]) regionCount[e]++;
    // Corner slots of region faces; slots of the same vertex connected through interior edges form a fan.
    const slotBase = new Map<number, number>();
    let nslots = 0;
    for (const f of faces) {
      slotBase.set(f, nslots);
      nslots += src.faces[f].length;
    }
    const slot = (f: number, i: number) => slotBase.get(f)! + i;
    const uf = new UnionFind(nslots);
    for (const f of faces) {
      const face = src.faces[f];
      const n = face.length;
      for (let i = 0; i < n; i++) {
        const e = topo.faceEdges[f][i];
        if (regionCount[e] !== 2) continue;
        const g = topo.edgeFaces[e].find((x) => x !== f && inR[x]);
        if (g === undefined) continue;
        const a = face[i];
        const b = face[(i + 1) % n];
        uf.union(slot(f, i), slot(g, src.faces[g].indexOf(a)));
        uf.union(slot(f, (i + 1) % n), slot(g, src.faces[g].indexOf(b)));
      }
    }
    interface Fan {
      v: number;
      n1: Vec3 | null;
      n2: Vec3 | null;
      normal: Vec3;
      newVert: number;
      planar: Vec3;
    }
    const fans = new Map<number, Fan>();
    for (const f of faces) {
      const face = src.faces[f];
      const n = face.length;
      const nrm = normals.get(f)!;
      for (let i = 0; i < n; i++) {
        const root = uf.find(slot(f, i));
        let fan = fans.get(root);
        if (!fan) {
          fan = {
            v: face[i],
            n1: null,
            n2: null,
            normal: [0, 0, 0],
            newVert: -1,
            planar: vpos(src, face[i]),
          };
          fans.set(root, fan);
        }
        fan.normal = [fan.normal[0] + nrm[0], fan.normal[1] + nrm[1], fan.normal[2] + nrm[2]];
        const p = vpos(src, face[i]);
        if (regionCount[topo.faceEdges[f][(i + n - 1) % n]] === 1 && !fan.n1)
          fan.n1 = inwardEdgeNormal(nrm, vpos(src, face[(i + n - 1) % n]), p);
        if (regionCount[topo.faceEdges[f][i]] === 1 && !fan.n2)
          fan.n2 = inwardEdgeNormal(nrm, p, vpos(src, face[(i + 1) % n]));
      }
    }
    for (const fan of fans.values()) {
      const nrm = normalize(fan.normal);
      const p = vpos(src, fan.v);
      const raised: Vec3 = [p[0] + nrm[0] * depth, p[1] + nrm[1] * depth, p[2] + nrm[2] * depth];
      if (!fan.n1 && !fan.n2) {
        // Interior vertex of the region: only follows the depth.
        setVpos(m, fan.v, raised);
        fan.newVert = fan.v;
        continue;
      }
      const d = miterDirection(fan.n1 ?? fan.n2!, fan.n2 ?? fan.n1!, even);
      fan.planar = [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];
      fan.newVert = addVertexFrom(
        m,
        [fan.planar[0] + nrm[0] * depth, fan.planar[1] + nrm[1] * depth, fan.planar[2] + nrm[2] * depth],
        [fan.v],
      );
    }
    for (const f of faces) {
      const rec = recs[f];
      const face = src.faces[f];
      const n = face.length;
      const frame = uvFrame(src, rec);
      const nv: number[] = [];
      const nuv: number[] = [];
      for (let i = 0; i < n; i++) {
        const fan = fans.get(uf.find(slot(f, i)))!;
        nv.push(fan.newVert);
        nuv.push(...(frame ? frame.at(fan.planar, i) : uvOf(rec, i)));
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (regionCount[topo.faceEdges[f][i]] !== 1) continue;
        walls.push(
          makeFace(m, [face[i], face[j], nv[j], nv[i]], rec, [
            ...uvOf(rec, i),
            ...uvOf(rec, j),
            nuv[j * 2],
            nuv[j * 2 + 1],
            nuv[i * 2],
            nuv[i * 2 + 1],
          ]),
        );
      }
      out[f] = { ...rec, v: nv, uv: rec.uv ? nuv : null, sel: true };
    }
  }
  const selected = writeFaces(m, [...out, ...walls]);
  pruneEdgeData(m);
  return { mesh: m, selection: selectionFromFaces(m, selected) };
}
