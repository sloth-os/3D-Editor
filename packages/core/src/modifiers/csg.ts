import type { Mat4 } from '../math/types';
import type { MeshData } from '../mesh/types';
import { vertexCount } from '../mesh/types';
import { triangulateFaceCorners } from '../mesh/triangulate';
import {
  MeshBuilder,
  PointGrid,
  UnionFind,
  boundsDiagonal,
  det3,
  hasColors,
  mergeVerticesByMap,
} from './util';
import { dissolveStraightVertices, mergeFaceRegions } from './polymerge';

/*
 * Constructive solid geometry with binary space partitioning trees.
 *
 * Both solids are converted to convex planar polygons and stored in BSP trees whose node planes are
 * polygon planes. Clipping a polygon set against a tree removes the parts inside the other solid;
 * inverting a tree turns a solid into its complement. Union, difference and intersection are compositions
 * of these two primitives (the classic scheme described by Naylor/Thibault and popularised by csg.js).
 *
 * Results are converted back to an indexed n-gon mesh: coincident vertices are welded, T-junctions created
 * by splitting are repaired (so closed inputs give closed outputs), fragments of the same input face are
 * merged back into n-gons and redundant vertices on straight edges are dissolved.
 */

export type CsgOperation = 'UNION' | 'DIFFERENCE' | 'INTERSECT';

/** Cleanup tolerances relative to the result size: vertex weld, T-junction repair and crack closing. */
const WELD_REL = 1e-9;
const TJ_REL = 1e-9;
const CRACK_REL = 1e-5;

interface CsgVertex {
  x: number;
  y: number;
  z: number;
  /** Optional per-corner attributes: [u, v] and [r, g, b, a]. */
  uv: number[] | null;
  color: number[] | null;
}

interface CsgPlane {
  nx: number;
  ny: number;
  nz: number;
  w: number;
}

/** Information shared by all fragments of one input face. */
export interface CsgFaceInfo {
  /** 0 = first operand, 1 = second operand. */
  src: number;
  face: number;
  material: number;
  smooth: boolean;
}

interface CsgPolygon {
  verts: CsgVertex[];
  plane: CsgPlane;
  info: CsgFaceInfo;
}

// scratch buffers for split() (grown on demand; split is not re-entrant)
let scratchTypes = new Uint8Array(64);
let scratchDists = new Float64Array(64);

/** Axis-aligned bounds of a polygon set: [minX, minY, minZ, maxX, maxY, maxZ]. */
function boundsOfPolygons(polys: CsgPolygon[]): number[] {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of polys) {
    for (const v of p.verts) {
      if (v.x < b[0]) b[0] = v.x;
      if (v.y < b[1]) b[1] = v.y;
      if (v.z < b[2]) b[2] = v.z;
      if (v.x > b[3]) b[3] = v.x;
      if (v.y > b[4]) b[4] = v.y;
      if (v.z > b[5]) b[5] = v.z;
    }
  }
  return b;
}

/** True when the polygon lies completely outside the box `b` grown by `margin`. */
function outsideBox(p: CsgPolygon, b: number[], margin: number): boolean {
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (const v of p.verts) {
    if (v.x < x0) x0 = v.x;
    if (v.y < y0) y0 = v.y;
    if (v.z < z0) z0 = v.z;
    if (v.x > x1) x1 = v.x;
    if (v.y > y1) y1 = v.y;
    if (v.z > z1) z1 = v.z;
  }
  return (
    x1 < b[0] - margin ||
    y1 < b[1] - margin ||
    z1 < b[2] - margin ||
    x0 > b[3] + margin ||
    y0 > b[4] + margin ||
    z0 > b[5] + margin
  );
}

const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

function lerpVertex(a: CsgVertex, b: CsgVertex, t: number): CsgVertex {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    uv: a.uv && b.uv ? [a.uv[0] + (b.uv[0] - a.uv[0]) * t, a.uv[1] + (b.uv[1] - a.uv[1]) * t] : a.uv,
    color: a.color && b.color ? a.color.map((c, i) => c + (b.color![i] - c) * t) : a.color,
  };
}

function flipPolygon(p: CsgPolygon): CsgPolygon {
  return {
    verts: p.verts.slice().reverse(),
    plane: { nx: -p.plane.nx, ny: -p.plane.ny, nz: -p.plane.nz, w: -p.plane.w },
    info: p.info,
  };
}

class BspNode {
  plane: CsgPlane | null = null;
  front: BspNode | null = null;
  back: BspNode | null = null;
  polygons: CsgPolygon[] = [];
  /** Root only: bounds of the solid's surface and whether the tree currently represents its complement. */
  solidBounds: number[] | null = null;
  inverted = false;

  constructor(private readonly eps: number) {}

  /** Splits `poly` by `plane` into the given lists. */
  split(
    plane: CsgPlane,
    poly: CsgPolygon,
    coplanarFront: CsgPolygon[],
    coplanarBack: CsgPolygon[],
    front: CsgPolygon[],
    back: CsgPolygon[],
  ): void {
    const eps = this.eps;
    const vs = poly.verts;
    const n = vs.length;
    let type = 0;
    if (scratchTypes.length < n) {
      scratchTypes = new Uint8Array(n * 2);
      scratchDists = new Float64Array(n * 2);
    }
    const types = scratchTypes;
    const dists = scratchDists;
    for (let i = 0; i < n; i++) {
      const v = vs[i];
      const d = plane.nx * v.x + plane.ny * v.y + plane.nz * v.z - plane.w;
      dists[i] = d;
      const t = d < -eps ? BACK : d > eps ? FRONT : COPLANAR;
      types[i] = t;
      type |= t;
    }
    switch (type) {
      case COPLANAR: {
        const dot = plane.nx * poly.plane.nx + plane.ny * poly.plane.ny + plane.nz * poly.plane.nz;
        (dot > 0 ? coplanarFront : coplanarBack).push(poly);
        break;
      }
      case FRONT:
        front.push(poly);
        break;
      case BACK:
        back.push(poly);
        break;
      default: {
        const f: CsgVertex[] = [];
        const b: CsgVertex[] = [];
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const ti = types[i];
          const tj = types[j];
          const vi = vs[i];
          if (ti !== BACK) f.push(vi);
          if (ti !== FRONT) b.push(vi);
          if ((ti | tj) === SPANNING) {
            const t = dists[i] / (dists[i] - dists[j]);
            const v = lerpVertex(vi, vs[j], t);
            f.push(v);
            b.push(v);
          }
        }
        if (f.length >= 3) front.push({ verts: f, plane: poly.plane, info: poly.info });
        if (b.length >= 3) back.push({ verts: b, plane: poly.plane, info: poly.info });
      }
    }
  }

  /** All nodes of the tree (pre-order). */
  nodes(): BspNode[] {
    const out: BspNode[] = [];
    const stack: BspNode[] = [this];
    while (stack.length) {
      const n = stack.pop()!;
      out.push(n);
      if (n.front) stack.push(n.front);
      if (n.back) stack.push(n.back);
    }
    return out;
  }

  /** Converts the solid into its complement. */
  invert(): void {
    this.inverted = !this.inverted;
    for (const n of this.nodes()) {
      n.polygons = n.polygons.map(flipPolygon);
      if (n.plane) n.plane = { nx: -n.plane.nx, ny: -n.plane.ny, nz: -n.plane.nz, w: -n.plane.w };
      const t = n.front;
      n.front = n.back;
      n.back = t;
    }
  }

  /** Removes the parts of `polygons` that are inside this solid. */
  clipPolygons(polygons: CsgPolygon[]): CsgPolygon[] {
    const result: CsgPolygon[] = [];
    let todo = polygons;
    if (this.solidBounds) {
      // polygons away from the solid's bounds are entirely outside it (inside its complement)
      todo = [];
      for (const p of polygons) {
        if (!outsideBox(p, this.solidBounds, this.eps * 4)) todo.push(p);
        else if (!this.inverted) result.push(p);
      }
    }
    const stack: [BspNode, CsgPolygon[]][] = [[this, todo]];
    while (stack.length) {
      const [node, list] = stack.pop()!;
      if (!list.length) continue;
      if (!node.plane) {
        for (const p of list) result.push(p);
        continue;
      }
      const front: CsgPolygon[] = [];
      const back: CsgPolygon[] = [];
      for (const p of list) this.split(node.plane, p, front, back, front, back);
      if (node.front) stack.push([node.front, front]);
      else for (const p of front) result.push(p);
      if (node.back) stack.push([node.back, back]);
    }
    return result;
  }

  /** Removes the parts of this tree's polygons that are inside `other`. */
  clipTo(other: BspNode): void {
    for (const n of this.nodes()) n.polygons = other.clipPolygons(n.polygons);
  }

  allPolygons(): CsgPolygon[] {
    const out: CsgPolygon[] = [];
    for (const n of this.nodes()) for (const p of n.polygons) out.push(p);
    return out;
  }

  build(polygons: CsgPolygon[]): void {
    const stack: [BspNode, CsgPolygon[]][] = [[this, polygons]];
    while (stack.length) {
      const [node, list] = stack.pop()!;
      if (!list.length) continue;
      if (!node.plane) node.plane = this.choosePlane(list);
      const front: CsgPolygon[] = [];
      const back: CsgPolygon[] = [];
      for (const p of list) this.split(node.plane, p, node.polygons, node.polygons, front, back);
      if (front.length) stack.push([(node.front ??= new BspNode(this.eps)), front]);
      if (back.length) stack.push([(node.back ??= new BspNode(this.eps)), back]);
    }
  }

  /** Picks the candidate plane (among a few polygons) that splits the fewest polygons. */
  private choosePlane(list: CsgPolygon[]): CsgPlane {
    if (list.length <= 3) return list[0].plane;
    const candidates = Math.min(5, list.length);
    const sample = Math.min(list.length, 64);
    const step = list.length / sample;
    let best = list[0].plane;
    let bestScore = Infinity;
    for (let c = 0; c < candidates; c++) {
      const plane = list[Math.floor((c * list.length) / candidates)].plane;
      let spans = 0;
      let front = 0;
      let back = 0;
      for (let s = 0; s < sample; s++) {
        const poly = list[Math.floor(s * step)];
        let type = 0;
        for (const v of poly.verts) {
          const d = plane.nx * v.x + plane.ny * v.y + plane.nz * v.z - plane.w;
          type |= d < -this.eps ? BACK : d > this.eps ? FRONT : COPLANAR;
        }
        if (type === SPANNING) spans++;
        else if (type === FRONT) front++;
        else if (type === BACK) back++;
      }
      const score = spans * 8 + Math.abs(front - back);
      if (score < bestScore) {
        bestScore = score;
        best = plane;
      }
    }
    return best;
  }
}

function planeOf(verts: CsgVertex[]): CsgPlane | null {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
    cx += a.x;
    cy += a.y;
    cz += a.z;
  }
  const l = Math.hypot(nx, ny, nz);
  if (l < 1e-30) return null;
  nx /= l;
  ny /= l;
  nz /= l;
  const k = 1 / verts.length;
  return { nx, ny, nz, w: nx * cx * k + ny * cy * k + nz * cz * k };
}

/** True if the polygon is planar within `eps` and strictly convex (no reflex corners). */
function isPlanarConvex(verts: CsgVertex[], plane: CsgPlane, eps: number): boolean {
  const n = verts.length;
  for (const v of verts)
    if (Math.abs(plane.nx * v.x + plane.ny * v.y + plane.nz * v.z - plane.w) > eps) return false;
  for (let i = 0; i < n; i++) {
    const a = verts[(i + n - 1) % n];
    const b = verts[i];
    const c = verts[(i + 1) % n];
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const uz = b.z - a.z;
    const vx = c.x - b.x;
    const vy = c.y - b.y;
    const vz = c.z - b.z;
    const cross =
      (uy * vz - uz * vy) * plane.nx + (uz * vx - ux * vz) * plane.ny + (ux * vy - uy * vx) * plane.nz;
    if (cross <= eps * eps) return false;
  }
  return true;
}

/**
 * Converts a mesh into convex planar polygons (non-convex / non-planar faces are triangulated).
 * `matrix` transforms positions (winding is flipped automatically for mirroring matrices).
 */
function meshToPolygons(
  m: MeshData,
  src: number,
  matrix: Mat4 | null,
  eps: number,
  materialOverride?: number,
): CsgPolygon[] {
  const P = m.positions;
  const n = vertexCount(m);
  const pos = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = P[i * 3];
    const y = P[i * 3 + 1];
    const z = P[i * 3 + 2];
    if (matrix) {
      pos[i * 3] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
      pos[i * 3 + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
      pos[i * 3 + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    } else {
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
    }
  }
  const flip = matrix ? det3(matrix) < 0 : false;
  const colors = hasColors(m) ? m.colors! : null;
  const out: CsgPolygon[] = [];
  const vertexAt = (f: number, corner: number): CsgVertex => {
    const v = m.faces[f][corner];
    const uv = m.uvs ? [m.uvs[f][corner * 2] ?? 0, m.uvs[f][corner * 2 + 1] ?? 0] : null;
    return {
      x: pos[v * 3],
      y: pos[v * 3 + 1],
      z: pos[v * 3 + 2],
      uv,
      color: colors ? [colors[v * 4], colors[v * 4 + 1], colors[v * 4 + 2], colors[v * 4 + 3]] : null,
    };
  };
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    if (face.length < 3) continue;
    const info: CsgFaceInfo = {
      src,
      face: f,
      material: materialOverride ?? m.faceMaterials[f] ?? 0,
      smooth: m.faceSmooth[f] ?? false,
    };
    let verts = face.map((_, i) => vertexAt(f, i));
    if (flip) verts = verts.reverse();
    const plane = planeOf(verts);
    if (plane && isPlanarConvex(verts, plane, eps)) {
      out.push({ verts, plane, info });
      continue;
    }
    const tris = triangulateFaceCorners(m, f);
    for (let t = 0; t < tris.length; t += 3) {
      let tv = [vertexAt(f, tris[t]), vertexAt(f, tris[t + 1]), vertexAt(f, tris[t + 2])];
      if (flip) tv = tv.reverse();
      const tp = planeOf(tv);
      if (tp) out.push({ verts: tv, plane: tp, info });
    }
  }
  return out;
}

function polygonsBounds(polys: CsgPolygon[]): number {
  const pts: number[] = [];
  for (const p of polys) for (const v of p.verts) pts.push(v.x, v.y, v.z);
  return boundsDiagonal(pts);
}

/** Runs a boolean operation on polygon sets; returns the resulting polygons. */
function runCsg(a: CsgPolygon[], b: CsgPolygon[], op: CsgOperation, eps: number): CsgPolygon[] {
  const A = new BspNode(eps);
  const B = new BspNode(eps);
  A.build(a);
  B.build(b);
  A.solidBounds = boundsOfPolygons(a);
  B.solidBounds = boundsOfPolygons(b);
  if (op === 'UNION') {
    A.clipTo(B);
    B.clipTo(A);
    B.invert();
    B.clipTo(A);
    B.invert();
    return A.allPolygons().concat(B.allPolygons());
  }
  if (op === 'DIFFERENCE') {
    A.invert();
    A.clipTo(B);
    B.clipTo(A);
    B.invert();
    B.clipTo(A);
    B.invert();
    return A.allPolygons().concat(B.allPolygons()).map(flipPolygon);
  }
  A.invert();
  B.clipTo(A);
  B.invert();
  A.clipTo(B);
  B.clipTo(A);
  return A.allPolygons().concat(B.allPolygons()).map(flipPolygon);
}

interface CleanupTolerances {
  /** Vertices closer than this are the same vertex (only rounding-level differences). */
  weld: number;
  /** Maximum distance of a vertex from an edge to be inserted into it (T-junction repair). */
  tjunction: number;
  /** Looser distance for a second pass over edges that are still unmatched. */
  crack: number;
}

/**
 * Converts CSG polygons into an indexed mesh: welds vertices, drops degenerate faces, repairs T-junctions,
 * merges fragments of the same source face and dissolves redundant straight-edge vertices.
 */
function polygonsToMesh(
  polys: CsgPolygon[],
  tolerances: CleanupTolerances,
  withUV: boolean,
  withColor: boolean,
): MeshData {
  const tol = tolerances.weld;
  const b = new MeshBuilder({ uvs: withUV, colors: withColor });
  const grid = new PointGrid(tol * 4);
  const index = (v: CsgVertex): number => {
    const hit = grid.nearest(v.x, v.y, v.z, tol);
    if (hit >= 0) return hit;
    const i = b.addVertexRGBA(v.x, v.y, v.z, v.color);
    grid.insert(i, v.x, v.y, v.z);
    return i;
  };
  const infos: CsgFaceInfo[] = [];
  for (const poly of polys) {
    const loop: number[] = [];
    const uv: number[] = [];
    for (const v of poly.verts) {
      const i = index(v);
      if (loop.length && loop[loop.length - 1] === i) continue;
      loop.push(i);
      uv.push(v.uv ? v.uv[0] : 0, v.uv ? v.uv[1] : 0);
    }
    while (loop.length > 1 && loop[0] === loop[loop.length - 1]) {
      loop.pop();
      uv.length -= 2;
    }
    if (loop.length < 3 || new Set(loop).size !== loop.length) continue;
    b.addFace(loop, poly.info.material, poly.info.smooth, withUV ? uv : null);
    infos.push(poly.info);
  }
  let mesh = b.build();
  mesh = repairTJunctions(mesh, tolerances.tjunction);
  // close remaining hairline cracks (epsilon classification artefacts): merge tiny vertex clusters around
  // unmatched edges, then insert nearby vertices into the edges that are still unmatched
  const kept: number[] = [];
  const collapsed = collapseShortEdges(mesh, tolerances.crack, true, kept);
  const groups = collapsed === mesh ? infos : kept.map((f) => infos[f]);
  mesh = repairTJunctions(collapsed, tolerances.crack);
  // merge fragments of the same input face back into n-gons
  const groupOf = groups.map((info) => info.src * 1_000_000_000 + info.face);
  const directed = new Map<string, number>();
  for (let f = 0; f < mesh.faces.length; f++) {
    const face = mesh.faces[f];
    for (let i = 0; i < face.length; i++) directed.set(`${face[i]},${face[(i + 1) % face.length]}`, f);
  }
  const pairs: [number, number][] = [];
  for (let f = 0; f < mesh.faces.length; f++) {
    const face = mesh.faces[f];
    for (let i = 0; i < face.length; i++) {
      const g = directed.get(`${face[(i + 1) % face.length]},${face[i]}`);
      if (g !== undefined && g > f && groupOf[g] === groupOf[f]) pairs.push([f, g]);
    }
  }
  mesh = mergeFaceRegions(mesh, pairs, { uvTolerance: withUV ? 1e-4 : -1 });
  return dissolveStraightVertices(mesh, 1e-6);
}

/**
 * Merges the endpoints of edges shorter than `tol` (clusters of nearly coincident vertices left by
 * near-degenerate splits), removing the sliver faces between them.
 */
function collapseShortEdges(m: MeshData, tol: number, onlyBroken = false, faceSource?: number[]): MeshData {
  const P = m.positions;
  const n = vertexCount(m);
  const uf = new UnionFind(n);
  const t2 = tol * tol;
  // vertices touching edges that are not matched by exactly one opposite edge
  let broken: Uint8Array | null = null;
  if (onlyBroken) {
    const count = new Map<string, number>();
    for (const f of m.faces)
      for (let i = 0; i < f.length; i++) {
        const k = `${f[i]},${f[(i + 1) % f.length]}`;
        count.set(k, (count.get(k) ?? 0) + 1);
      }
    broken = new Uint8Array(n);
    let anyBroken = false;
    for (const [k, c] of count) {
      const [a, b] = k.split(',').map(Number);
      if (c === 1 && count.get(`${b},${a}`) === 1) continue;
      broken[a] = broken[b] = 1;
      anyBroken = true;
    }
    if (!anyBroken) return m;
  }
  let any = false;
  for (const f of m.faces) {
    for (let i = 0; i < f.length; i++) {
      const u = f[i];
      const v = f[(i + 1) % f.length];
      if (broken && !(broken[u] && broken[v])) continue;
      const a = u * 3;
      const b = v * 3;
      const d = (P[a] - P[b]) ** 2 + (P[a + 1] - P[b + 1]) ** 2 + (P[a + 2] - P[b + 2]) ** 2;
      if (d < t2) {
        uf.union(u, v);
        any = true;
      }
    }
  }
  return any ? mergeVerticesByMap(m, uf.roots(), m.positions, faceSource) : m;
}

/** Inserts vertices that lie on the interior of an unmatched edge into that edge (T-junction repair). */
function repairTJunctions(m: MeshData, tol: number): MeshData {
  const directed = new Set<string>();
  for (const f of m.faces)
    for (let i = 0; i < f.length; i++) directed.add(`${f[i]},${f[(i + 1) % f.length]}`);
  const P = m.positions;
  const n = vertexCount(m);
  let open = 0;
  for (const f of m.faces)
    for (let i = 0; i < f.length; i++) if (!directed.has(`${f[(i + 1) % f.length]},${f[i]}`)) open++;
  if (open === 0) return m;
  // coarse grid over all vertices for segment queries
  const diag = boundsDiagonal(P) || 1;
  const cell = Math.max(diag / 64, tol * 4);
  const cells = new Map<string, number[]>();
  const ck = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (let i = 0; i < n; i++) {
    const k = ck(
      Math.floor(P[i * 3] / cell),
      Math.floor(P[i * 3 + 1] / cell),
      Math.floor(P[i * 3 + 2] / cell),
    );
    const c = cells.get(k);
    if (c) c.push(i);
    else cells.set(k, [i]);
  }
  const onSegment = (a: number, b: number): { v: number; t: number }[] => {
    const ax = P[a * 3];
    const ay = P[a * 3 + 1];
    const az = P[a * 3 + 2];
    const dx = P[b * 3] - ax;
    const dy = P[b * 3 + 1] - ay;
    const dz = P[b * 3 + 2] - az;
    const len2 = dx * dx + dy * dy + dz * dz;
    if (len2 < tol * tol) return [];
    const x0 = Math.floor((Math.min(ax, ax + dx) - tol) / cell);
    const x1 = Math.floor((Math.max(ax, ax + dx) + tol) / cell);
    const y0 = Math.floor((Math.min(ay, ay + dy) - tol) / cell);
    const y1 = Math.floor((Math.max(ay, ay + dy) + tol) / cell);
    const z0 = Math.floor((Math.min(az, az + dz) - tol) / cell);
    const z1 = Math.floor((Math.max(az, az + dz) + tol) / cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 50000) return [];
    const hits: { v: number; t: number }[] = [];
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++) {
          const c = cells.get(ck(x, y, z));
          if (!c) continue;
          for (const v of c) {
            if (v === a || v === b) continue;
            const px = P[v * 3] - ax;
            const py = P[v * 3 + 1] - ay;
            const pz = P[v * 3 + 2] - az;
            const t = (px * dx + py * dy + pz * dz) / len2;
            if (t <= 0 || t >= 1) continue;
            const ex = px - dx * t;
            const ey = py - dy * t;
            const ez = pz - dz * t;
            if (ex * ex + ey * ey + ez * ez <= tol * tol) hits.push({ v, t });
          }
        }
    hits.sort((p, q) => p.t - q.t);
    return hits;
  };
  const faces: number[][] = [];
  const uvs: number[][] | null = m.uvs ? [] : null;
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    const uv = m.uvs ? m.uvs[f] : null;
    const nf: number[] = [];
    const nuv: number[] = [];
    for (let i = 0; i < face.length; i++) {
      const j = (i + 1) % face.length;
      const a = face[i];
      const c = face[j];
      nf.push(a);
      if (uv) nuv.push(uv[i * 2], uv[i * 2 + 1]);
      if (directed.has(`${c},${a}`)) continue;
      for (const h of onSegment(a, c)) {
        if (nf.includes(h.v) || face.includes(h.v)) continue;
        nf.push(h.v);
        if (uv)
          nuv.push(
            uv[i * 2] + (uv[j * 2] - uv[i * 2]) * h.t,
            uv[i * 2 + 1] + (uv[j * 2 + 1] - uv[i * 2 + 1]) * h.t,
          );
      }
    }
    faces.push(nf);
    if (uvs) uvs.push(nuv);
  }
  return { ...m, faces, uvs };
}

/**
 * Boolean operation between two meshes. `b` is transformed into `a`'s space by `bMatrix` (if given).
 * Faces coming from `b` use `bMaterial` as material index when given.
 */
export function csgMeshBoolean(
  a: MeshData,
  b: MeshData,
  op: CsgOperation,
  opts: { bMatrix?: Mat4 | null; bMaterial?: number; tolerance?: number } = {},
): MeshData {
  const bMatrix = opts.bMatrix ?? null;
  const roughA = boundsDiagonal(a.positions);
  const roughB = boundsDiagonal(b.positions) * (bMatrix ? Math.cbrt(Math.abs(det3(bMatrix))) || 1 : 1);
  const scale = Math.max(roughA, roughB, 1e-6);
  const eps = Math.max(opts.tolerance ?? 0, scale * 1e-6);
  const pa = meshToPolygons(a, 0, null, eps);
  const pb = meshToPolygons(b, 1, bMatrix, eps, opts.bMaterial);
  const result = runCsg(pa, pb, op, eps);
  const diag = Math.max(polygonsBounds(result), 1e-6);
  const withUV = !!a.uvs || !!b.uvs;
  const withColor = hasColors(a) || hasColors(b);
  return polygonsToMesh(
    result,
    { weld: diag * WELD_REL, tjunction: diag * TJ_REL, crack: diag * CRACK_REL },
    withUV,
    withColor,
  );
}
