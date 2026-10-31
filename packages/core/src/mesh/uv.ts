import type { Vec3 } from '../math/types';
import type { MeshData } from './types';
import { cloneMesh, edgeKey, ensureUVs } from './types';
import type { MeshSelection } from './selection';
import { buildTopology } from './topology';
import { faceArea, faceNormalRaw } from './normals';
import type { MeshOpResult } from './ops/types';

/*
 * UV mapping (Blender's U menu). Every function works on the selected faces (all faces when no
 * face is selected), creates the UV layer if the mesh has none, leaves other faces untouched and
 * returns the selection unchanged. Coordinates are in object local space.
 */

export interface UVBoundsOptions {
  /** Scale the new UVs (non-uniformly) to fill the 0..1 square. */
  scaleToBounds?: boolean;
  /** Clamp the new UVs into the 0..1 square. */
  clipToBounds?: boolean;
}

export type UVAxis = 'X' | 'Y' | 'Z';

function targetFaces(m: MeshData, sel: MeshSelection): number[] {
  const faces = [...sel.faces].filter((f) => f >= 0 && f < m.faces.length).sort((a, b) => a - b);
  return faces.length ? faces : m.faces.map((_, f) => f);
}

function pos(m: MeshData, v: number): Vec3 {
  return [m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]];
}

function boundsCenter(m: MeshData, faces: number[]): Vec3 {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const f of faces)
    for (const v of m.faces[f])
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], m.positions[v * 3 + k]);
        hi[k] = Math.max(hi[k], m.positions[v * 3 + k]);
      }
  if (!Number.isFinite(lo[0])) return [0, 0, 0];
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
}

function finishBounds(uvs: number[][], faces: number[], opts: UVBoundsOptions): void {
  if (opts.scaleToBounds) {
    let u0 = Infinity;
    let v0 = Infinity;
    let u1 = -Infinity;
    let v1 = -Infinity;
    for (const f of faces)
      for (let i = 0; i < uvs[f].length; i += 2) {
        u0 = Math.min(u0, uvs[f][i]);
        u1 = Math.max(u1, uvs[f][i]);
        v0 = Math.min(v0, uvs[f][i + 1]);
        v1 = Math.max(v1, uvs[f][i + 1]);
      }
    const su = u1 - u0 > 1e-12 ? 1 / (u1 - u0) : 1;
    const sv = v1 - v0 > 1e-12 ? 1 / (v1 - v0) : 1;
    for (const f of faces)
      for (let i = 0; i < uvs[f].length; i += 2) {
        uvs[f][i] = (uvs[f][i] - u0) * su;
        uvs[f][i + 1] = (uvs[f][i + 1] - v0) * sv;
      }
  }
  if (opts.clipToBounds) for (const f of faces) uvs[f] = uvs[f].map((x) => Math.min(1, Math.max(0, x)));
}

/** Axis frame (u, v, along) for a projection axis. */
function axisFrame(axis: UVAxis): [Vec3, Vec3, Vec3] {
  if (axis === 'X')
    return [
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 0],
    ];
  if (axis === 'Y')
    return [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ];
  return [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
}

/**
 * Cube projection: every face is projected along the axis its normal is most aligned with
 * (without mirroring), scaled by 1 / cube_size around the center of the faces' bounding box.
 */
export function cubeProject(
  src: MeshData,
  sel: MeshSelection,
  opts: UVBoundsOptions & { cubeSize?: number } = {},
): MeshOpResult {
  const m = cloneMesh(src);
  const uvs = ensureUVs(m);
  const faces = targetFaces(m, sel);
  const size = opts.cubeSize && opts.cubeSize > 0 ? opts.cubeSize : 1;
  const c = boundsCenter(m, faces);
  for (const f of faces) {
    const n = faceNormalRaw(m, f);
    const ax = Math.abs(n[0]);
    const ay = Math.abs(n[1]);
    const az = Math.abs(n[2]);
    let pu: (p: Vec3) => number;
    let pv: (p: Vec3) => number;
    if (az >= ax && az >= ay) {
      pu = (p) => p[0];
      pv = (p) => (n[2] >= 0 ? p[1] : -p[1]);
    } else if (ax >= ay) {
      pu = (p) => (n[0] >= 0 ? p[1] : -p[1]);
      pv = (p) => p[2];
    } else {
      pu = (p) => (n[1] >= 0 ? -p[0] : p[0]);
      pv = (p) => p[2];
    }
    uvs[f] = m.faces[f].flatMap((v) => {
      const p = pos(m, v);
      const q: Vec3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
      return [pu(q) / size + 0.5, pv(q) / size + 0.5];
    });
  }
  finishBounds(uvs, faces, opts);
  return { mesh: m, selection: sel };
}

/** Wraps a face's u coordinates so it does not span the 0/1 seam; fills undefined pole corners. */
function fixWrap(us: (number | null)[]): number[] {
  const known = us.filter((u): u is number => u !== null);
  if (known.length === 0) return us.map(() => 0.5);
  let fixed = known;
  if (Math.max(...known) - Math.min(...known) > 0.5) fixed = known.map((u) => (u < 0.5 ? u + 1 : u));
  const avg = fixed.reduce((a, b) => a + b, 0) / fixed.length;
  let k = 0;
  return us.map((u) => (u === null ? avg : fixed[k++]));
}

function radialProject(
  src: MeshData,
  sel: MeshSelection,
  opts: UVBoundsOptions & { axis?: UVAxis; radius?: number },
  vOf: (h: number, rho: number) => number,
): MeshOpResult {
  const m = cloneMesh(src);
  const uvs = ensureUVs(m);
  const faces = targetFaces(m, sel);
  const c = boundsCenter(m, faces);
  const [eu, ev, ea] = axisFrame(opts.axis ?? 'Z');
  for (const f of faces) {
    const us: (number | null)[] = [];
    const vs: number[] = [];
    for (const v of m.faces[f]) {
      const p = pos(m, v);
      const q: Vec3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
      const x = q[0] * eu[0] + q[1] * eu[1] + q[2] * eu[2];
      const y = q[0] * ev[0] + q[1] * ev[1] + q[2] * ev[2];
      const h = q[0] * ea[0] + q[1] * ea[1] + q[2] * ea[2];
      const rho = Math.hypot(x, y);
      us.push(rho < 1e-9 ? null : Math.atan2(y, x) / (2 * Math.PI) + 0.5);
      vs.push(vOf(h, rho));
    }
    const uu = fixWrap(us);
    uvs[f] = uu.flatMap((u, i) => [u, vs[i]]);
  }
  finishBounds(uvs, faces, opts);
  return { mesh: m, selection: sel };
}

/** Cylinder projection around a local axis (u = angle around the axis, v = height / (2 radius)). */
export function cylinderProject(
  src: MeshData,
  sel: MeshSelection,
  opts: UVBoundsOptions & { axis?: UVAxis; radius?: number } = {},
): MeshOpResult {
  const r = opts.radius && opts.radius > 0 ? opts.radius : 1;
  return radialProject(src, sel, opts, (h) => h / (2 * r) + 0.5);
}

/** Sphere projection around a local axis (u = longitude, v = latitude). */
export function sphereProject(
  src: MeshData,
  sel: MeshSelection,
  opts: UVBoundsOptions & { axis?: UVAxis } = {},
): MeshOpResult {
  return radialProject(src, sel, opts, (h, rho) => Math.atan2(h, rho) / Math.PI + 0.5);
}

// ---------------------------------------------------------------------------------- smart project

export interface SmartProjectOptions {
  /** Faces whose normals differ by less than this angle (radians) share a projection. Default 66°. */
  angleLimit?: number;
  /** Space between islands, as a fraction of the UV square. Default 0. */
  islandMargin?: number;
}

function convexHull(pts: [number, number][]): [number, number][] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const crossZ = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

interface Chart {
  faces: number[];
  /** Per face: flat corner coordinates in chart space. */
  coords: Map<number, number[]>;
  w: number;
  h: number;
}

/** Shelf packing of rectangles (tallest first); returns positions and the used square extent. */
function shelfPack(
  boxes: { w: number; h: number }[],
  width: number,
  margin: number,
): { pos: { x: number; y: number }[]; extent: number } {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[b].h - boxes[a].h || boxes[b].w - boxes[a].w);
  const pos: { x: number; y: number }[] = new Array(boxes.length);
  let x = 0;
  let y = 0;
  let shelf = 0;
  let maxX = 0;
  for (const i of order) {
    const w = boxes[i].w + 2 * margin;
    const h = boxes[i].h + 2 * margin;
    if (x > 0 && x + w > width) {
      y += shelf;
      x = 0;
      shelf = 0;
    }
    pos[i] = { x: x + margin, y: y + margin };
    x += w;
    shelf = Math.max(shelf, h);
    maxX = Math.max(maxX, x);
  }
  return { pos, extent: Math.max(maxX, y + shelf) };
}

/**
 * Smart UV Project: faces are grouped by normal direction (within `angleLimit`), every connected
 * group (not crossing UV seams) becomes an island that is projected along its average normal,
 * rotated to its smallest bounding box and packed into the 0..1 square with a shelf packer.
 */
export function smartProject(
  src: MeshData,
  sel: MeshSelection,
  opts: SmartProjectOptions = {},
): MeshOpResult {
  const m = cloneMesh(src);
  const uvs = ensureUVs(m);
  const faces = targetFaces(m, sel);
  if (faces.length === 0) return { mesh: m, selection: sel };
  const limit = Math.cos(Math.min(Math.PI, Math.max(0, opts.angleLimit ?? (66 * Math.PI) / 180)));
  const normal = new Map<number, Vec3>();
  const area = new Map<number, number>();
  for (const f of faces) {
    const n = faceNormalRaw(m, f);
    const l = Math.hypot(n[0], n[1], n[2]);
    normal.set(f, l > 1e-14 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 1]);
    area.set(f, faceArea(m, f));
  }
  // 1. Projection directions.
  const dirs: Vec3[] = [];
  const dirOf = new Map<number, number>();
  const best = (n: Vec3): [number, number] => {
    let bi = -1;
    let bd = -Infinity;
    dirs.forEach((d, i) => {
      const x = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
      if (x > bd) {
        bd = x;
        bi = i;
      }
    });
    return [bi, bd];
  };
  for (const f of [...faces].sort((a, b) => area.get(b)! - area.get(a)!)) {
    const n = normal.get(f)!;
    const [bi, bd] = best(n);
    if (bi >= 0 && bd >= limit) dirOf.set(f, bi);
    else {
      dirs.push(n);
      dirOf.set(f, dirs.length - 1);
    }
  }
  // Refine every direction to the area-weighted mean of its faces, then reassign.
  const acc = dirs.map(() => [0, 0, 0] as Vec3);
  for (const f of faces) {
    const n = normal.get(f)!;
    const a = Math.max(area.get(f)!, 1e-12);
    const d = acc[dirOf.get(f)!];
    d[0] += n[0] * a;
    d[1] += n[1] * a;
    d[2] += n[2] * a;
  }
  acc.forEach((d, i) => {
    const l = Math.hypot(d[0], d[1], d[2]);
    if (l > 1e-12) dirs[i] = [d[0] / l, d[1] / l, d[2] / l];
  });
  for (const f of faces) {
    const [bi, bd] = best(normal.get(f)!);
    if (bd >= limit) dirOf.set(f, bi);
  }
  // 2. Charts: connected faces with the same direction, not across seams.
  const topo = buildTopology(m);
  const isTarget = new Set(faces);
  const chartOf = new Map<number, number>();
  const charts: number[][] = [];
  for (const f of faces) {
    if (chartOf.has(f)) continue;
    const id = charts.length;
    const list = [f];
    chartOf.set(f, id);
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      for (const e of topo.faceEdges[g]) {
        const ef = topo.edgeFaces[e];
        if (ef.length !== 2) continue;
        const [a, b] = topo.edges[e];
        if (m.edgeAttrs[edgeKey(a, b)]?.seam) continue;
        const h = ef[0] === g ? ef[1] : ef[0];
        if (!isTarget.has(h) || chartOf.has(h) || dirOf.get(h) !== dirOf.get(g)) continue;
        chartOf.set(h, id);
        list.push(h);
      }
    }
    charts.push(list);
  }
  // 3. Project each chart and rotate it to its smallest bounding box.
  const built: Chart[] = charts.map((list) => {
    const d = dirs[dirOf.get(list[0])!];
    const ax = Math.abs(d[0]);
    const ay = Math.abs(d[1]);
    const az = Math.abs(d[2]);
    const o: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
    let t: Vec3 = [d[1] * o[2] - d[2] * o[1], d[2] * o[0] - d[0] * o[2], d[0] * o[1] - d[1] * o[0]];
    const tl = Math.hypot(t[0], t[1], t[2]) || 1;
    t = [t[0] / tl, t[1] / tl, t[2] / tl];
    const b: Vec3 = [d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]];
    const raw = new Map<number, number[]>();
    const all: [number, number][] = [];
    for (const f of list) {
      const c = m.faces[f].flatMap((v) => {
        const p = pos(m, v);
        const q: [number, number] = [
          p[0] * t[0] + p[1] * t[1] + p[2] * t[2],
          p[0] * b[0] + p[1] * b[1] + p[2] * b[2],
        ];
        all.push(q);
        return q;
      });
      raw.set(f, c);
    }
    const hull = convexHull(all);
    let bestAngle = 0;
    let bestArea = Infinity;
    const candidates =
      hull.length >= 2
        ? hull.map((p, i) =>
            Math.atan2(hull[(i + 1) % hull.length][1] - p[1], hull[(i + 1) % hull.length][0] - p[0]),
          )
        : [0];
    for (const ang of candidates) {
      const cs = Math.cos(-ang);
      const sn = Math.sin(-ang);
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const [x, y] of hull) {
        const rx = x * cs - y * sn;
        const ry = x * sn + y * cs;
        x0 = Math.min(x0, rx);
        x1 = Math.max(x1, rx);
        y0 = Math.min(y0, ry);
        y1 = Math.max(y1, ry);
      }
      const a = (x1 - x0) * (y1 - y0);
      if (a < bestArea - 1e-12) {
        bestArea = a;
        bestAngle = ang;
      }
    }
    const cs = Math.cos(-bestAngle);
    const sn = Math.sin(-bestAngle);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const coords = new Map<number, number[]>();
    for (const [f, c] of raw) {
      const rc: number[] = [];
      for (let i = 0; i < c.length; i += 2) {
        const rx = c[i] * cs - c[i + 1] * sn;
        const ry = c[i] * sn + c[i + 1] * cs;
        rc.push(rx, ry);
        x0 = Math.min(x0, rx);
        x1 = Math.max(x1, rx);
        y0 = Math.min(y0, ry);
        y1 = Math.max(y1, ry);
      }
      coords.set(f, rc);
    }
    for (const rc of coords.values())
      for (let i = 0; i < rc.length; i += 2) {
        rc[i] -= x0;
        rc[i + 1] -= y0;
      }
    return { faces: list, coords, w: Math.max(x1 - x0, 1e-9), h: Math.max(y1 - y0, 1e-9) };
  });
  // 4. Pack: try a few shelf widths, keep the most compact layout.
  const totalArea = built.reduce((a, c) => a + c.w * c.h, 0);
  const maxW = Math.max(...built.map((c) => c.w));
  const marginFrac = Math.max(0, opts.islandMargin ?? 0);
  const layout = (margin: number) => {
    let bestL: ReturnType<typeof shelfPack> | null = null;
    for (const k of [0.8, 1, 1.25, 1.6, 2]) {
      const width = Math.max(maxW + 2 * margin, Math.sqrt(totalArea) * k);
      const l = shelfPack(built, width, margin);
      if (!bestL || l.extent < bestL.extent) bestL = l;
    }
    return bestL!;
  };
  let packed = layout(0);
  // Half the margin on each side of an island ≈ `islandMargin` between neighbours after scaling.
  if (marginFrac > 0) packed = layout((marginFrac / 2) * packed.extent);
  const scale = 1 / Math.max(packed.extent, 1e-12);
  built.forEach((c, i) => {
    const o = packed.pos[i];
    for (const f of c.faces) {
      const rc = c.coords.get(f)!;
      uvs[f] = rc.map((x, k) => Math.min(1, Math.max(0, ((k % 2 === 0 ? o.x : o.y) + x) * scale)));
    }
  });
  return { mesh: m, selection: sel };
}

/** Resets the UVs of the faces: every face covers the whole 0..1 square (quads map to the corners). */
export function resetUVs(src: MeshData, sel: MeshSelection): MeshOpResult {
  const m = cloneMesh(src);
  const uvs = ensureUVs(m);
  for (const f of targetFaces(m, sel)) {
    const n = m.faces[f].length;
    if (n === 4) uvs[f] = [0, 0, 1, 0, 1, 1, 0, 1];
    else if (n === 3) uvs[f] = [0, 0, 1, 0, 1, 1];
    else {
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = Math.PI / 2 + (2 * Math.PI * i) / n;
        out.push(0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
      }
      uvs[f] = out;
    }
  }
  return { mesh: m, selection: sel };
}
