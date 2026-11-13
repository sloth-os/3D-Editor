import type { Mat4, Vec3 } from '../../math/types';
import { axisAngle4, invert4, multiply4, translation4 } from '../../math/mat4';
import { transformPoint3 } from '../../math/vec3';
import type { MeshData } from '../types';
import { cloneMesh, pruneEdgeData } from '../types';
import type { MeshSelection } from '../selection';
import { selectionFromVerts } from '../selection';
import { buildTopology } from '../topology';
import { faceArea, faceCenter, faceNormal } from '../normals';
import type { MeshOpResult } from './types';
import {
  addVertexFrom,
  allFaceRecs,
  completeSelection,
  copyEdgeAttr,
  type FaceRec,
  makeFace,
  removeUnusedAmong,
  requireNonEmpty,
  reverseFace,
  uvOf,
  writeFaces,
} from './util';

export interface SpinOptions {
  /** Number of steps (default 12). */
  steps?: number;
  /** Total rotation in radians (default π/2); a full turn (2π) closes the result. */
  angle?: number;
  /** Rotation center (object local space, or world space when `matrix` is given). */
  center?: Readonly<Vec3>;
  /** Rotation axis (object local space, or world space when `matrix` is given). Default +Z. */
  axis?: Readonly<Vec3>;
  /** Make unconnected rotated copies instead of sweeping. */
  dupli?: boolean;
  /** Merge the last step with the start for full turns (default true). */
  autoMerge?: boolean;
  /** Flip the normals of the generated faces. */
  flipNormals?: boolean;
  /** Object world matrix: center/axis are then world-space and the rotation happens in world space. */
  matrix?: Readonly<Mat4>;
}

/**
 * Spin (lathe): sweeps the selected geometry around an axis in `steps` steps. Selected edges and
 * vertices become surfaces / edges; selected faces are swept into solids (a free-standing face
 * keeps its start cap, so the result is closed). Free-standing results are oriented away from the
 * axis. The last step is selected.
 */
export function spin(src: MeshData, sel: MeshSelection, opts: SpinOptions = {}): MeshOpResult {
  const steps = Math.max(1, Math.floor(opts.steps ?? 12));
  const angle = opts.angle ?? Math.PI / 2;
  const axisIn = opts.axis ?? [0, 0, 1];
  const al = Math.hypot(axisIn[0], axisIn[1], axisIn[2]);
  if (al < 1e-12) throw new Error('Spin axis must not be zero');
  const axis: Vec3 = [axisIn[0] / al, axisIn[1] / al, axisIn[2] / al];
  const center: Vec3 = [...(opts.center ?? [0, 0, 0])] as Vec3;
  let step: Mat4 = multiply4(
    translation4(center),
    multiply4(axisAngle4(axis, angle / steps), translation4([-center[0], -center[1], -center[2]])),
  );
  if (opts.matrix) step = multiply4(invert4(opts.matrix), multiply4(step, opts.matrix));
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  requireNonEmpty(s.verts.size, 'geometry');
  const full = Math.abs(Math.abs(angle) - 2 * Math.PI) < 1e-6;
  const merge = full && (opts.autoMerge ?? true) && !opts.dupli;
  const m = cloneMesh(src);
  const recs = allFaceRecs(src);
  const profile = [...s.verts].sort((a, b) => a - b);
  // copies[k] maps profile vertex → its copy after k steps (k = 0 is the original).
  const copies: Map<number, number>[] = [new Map(profile.map((v) => [v, v]))];
  const created: number[] = [];
  let pos = new Map(
    profile.map((v) => [
      v,
      [src.positions[v * 3], src.positions[v * 3 + 1], src.positions[v * 3 + 2]] as Vec3,
    ]),
  );
  for (let k = 1; k <= steps; k++) {
    const next = new Map<number, number>();
    const npos = new Map<number, Vec3>();
    for (const v of profile) {
      const p = transformPoint3(step, pos.get(v)!);
      npos.set(v, p);
      const copy = merge && k === steps ? v : addVertexFrom(m, p, [v]);
      if (copy !== v) created.push(copy);
      next.set(v, copy);
    }
    copies.push(next);
    pos = npos;
  }
  const out: FaceRec[] = recs.slice();
  const added: FaceRec[] = [];
  const regionFaces = [...s.faces].sort((a, b) => a - b);
  const inR = new Set(regionFaces);
  const last = copies[steps];
  if (opts.dupli) {
    for (let k = 1; k <= steps; k++) {
      const c = copies[k];
      for (const f of regionFaces)
        added.push({ ...recs[f], v: recs[f].v.map((v) => c.get(v)!), sel: k === steps });
      for (const key of s.edges) {
        const e = topo.edgeIndex.get(key)!;
        if (topo.edgeFaces[e].some((f) => inR.has(f))) continue;
        const [a, b] = topo.edges[e];
        m.looseEdges.push(c.get(a)!, c.get(b)!);
      }
    }
    writeFaces(m, [...out, ...added]);
    pruneEdgeData(m);
    return { mesh: m, selection: selectionFromVerts(m, [...last.values()]) };
  }
  const regionCount = new Int32Array(topo.edges.length);
  for (const f of regionFaces) for (const e of topo.faceEdges[f]) regionCount[e]++;
  // Is the swept region free-standing (no unselected faces attached to its outline)?
  let freeRegion = regionFaces.length > 0;
  const generated: FaceRec[] = [];
  const sweep = (a: number, b: number, like: FaceRec | null, uv: [number, number][] | null) => {
    for (let k = 1; k <= steps; k++) {
      const p = copies[k - 1];
      const c = copies[k];
      const quad = makeFace(
        m,
        [p.get(a)!, p.get(b)!, c.get(b)!, c.get(a)!],
        like,
        uv ? [...uv[0], ...uv[1], ...uv[1], ...uv[0]] : null,
      );
      generated.push(quad);
      copyEdgeAttr(m, a, b, c.get(a)!, c.get(b)!);
    }
  };
  for (const f of regionFaces) {
    const face = src.faces[f];
    for (let i = 0; i < face.length; i++) {
      const e = topo.faceEdges[f][i];
      if (regionCount[e] !== 1) continue;
      if (topo.edgeFaces[e].length > 1) freeRegion = false;
      const j = (i + 1) % face.length;
      sweep(face[i], face[j], recs[f], [uvOf(recs[f], i), uvOf(recs[f], j)]);
    }
  }
  const edgeOnly: number[] = [];
  for (const key of s.edges) {
    const e = topo.edgeIndex.get(key)!;
    if (topo.edgeFaces[e].some((f) => inR.has(f))) continue;
    edgeOnly.push(e);
  }
  for (const e of edgeOnly) {
    const [a, b] = topo.edges[e];
    const g = topo.edgeFaces[e][0];
    if (g !== undefined) {
      const face = src.faces[g];
      const ia = face.indexOf(a);
      const forward = face[(ia + 1) % face.length] === b;
      const uv: [number, number][] = [uvOf(recs[g], ia), uvOf(recs[g], face.indexOf(b))];
      if (forward) sweep(b, a, recs[g], [uv[1], uv[0]]);
      else sweep(a, b, recs[g], uv);
    } else sweep(a, b, null, null);
  }
  const edgeVerts = new Set<number>();
  for (const key of s.edges) for (const v of key.split(',')) edgeVerts.add(Number(v));
  for (const v of profile) {
    if (edgeVerts.has(v)) continue;
    for (let k = 1; k <= steps; k++)
      if (copies[k - 1].get(v) !== copies[k].get(v))
        m.looseEdges.push(copies[k - 1].get(v)!, copies[k].get(v)!);
  }
  // Region faces: move to the end of the sweep; free-standing regions keep a start cap.
  const caps: FaceRec[] = [];
  for (const f of regionFaces) {
    if (merge) {
      out[f] = { ...recs[f], v: [] };
      continue;
    }
    out[f] = { ...recs[f], v: recs[f].v.map((v) => last.get(v)!), sel: true };
    if (freeRegion)
      caps.push(
        reverseFace({ ...recs[f], v: recs[f].v.slice(), uv: recs[f].uv ? recs[f].uv.slice() : null }),
      );
  }
  // Orientation of free-standing results: outward from the axis (or by signed volume for solids).
  const free = regionFaces.length ? freeRegion : edgeOnly.every((e) => topo.edgeFaces[e].length === 0);
  const tmp = cloneMesh(m);
  const swept = [...generated, ...caps, ...regionFaces.filter(() => !merge).map((f) => out[f])];
  writeFaces(tmp, swept);
  let flip = false;
  if (free && swept.length) {
    if (regionFaces.length) {
      let vol = 0;
      for (let f = 0; f < tmp.faces.length; f++) {
        const n = faceNormal(tmp, f);
        const c = faceCenter(tmp, f);
        const area = faceArea(tmp, f);
        vol += (n[0] * c[0] + n[1] * c[1] + n[2] * c[2]) * area;
      }
      flip = vol < 0;
    } else {
      // Rotation axis in local space for the "away from axis" test.
      const inv = opts.matrix ? invert4(opts.matrix) : null;
      const ctr = inv ? transformPoint3(inv, center) : center;
      const tip = inv
        ? transformPoint3(inv, [center[0] + axis[0], center[1] + axis[1], center[2] + axis[2]])
        : ([center[0] + axis[0], center[1] + axis[1], center[2] + axis[2]] as Vec3);
      const ax: Vec3 = [tip[0] - ctr[0], tip[1] - ctr[1], tip[2] - ctr[2]];
      const axl = Math.hypot(ax[0], ax[1], ax[2]) || 1;
      let score = 0;
      for (let f = 0; f < tmp.faces.length; f++) {
        const n = faceNormal(tmp, f);
        const c = faceCenter(tmp, f);
        const d: Vec3 = [c[0] - ctr[0], c[1] - ctr[1], c[2] - ctr[2]];
        const t = (d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2]) / (axl * axl);
        const r: Vec3 = [d[0] - ax[0] * t, d[1] - ax[1] * t, d[2] - ax[2] * t];
        score += n[0] * r[0] + n[1] * r[1] + n[2] * r[2];
      }
      flip = score < 0;
    }
  }
  if (opts.flipNormals) flip = !flip;
  if (flip && free) {
    for (const r of generated) reverseFace(r);
    for (const r of caps) reverseFace(r);
    if (!merge) for (const f of regionFaces) reverseFace(out[f]);
  }
  writeFaces(m, [...out.filter((r) => r.v.length >= 3), ...generated, ...caps]);
  pruneEdgeData(m);
  // Region-interior vertices (and their intermediate copies) are no longer used once the region
  // moved to the end of the sweep.
  const remap = removeUnusedAmong(m, [...regionFaces.flatMap((f) => src.faces[f]), ...created]);
  const lastSel = merge ? profile : [...last.values()];
  return {
    mesh: m,
    selection: selectionFromVerts(
      m,
      lastSel.map((v) => remap[v]).filter((v) => v >= 0),
    ),
  };
}
