import type { Mat4, Vec2, Vec3 } from '../math/types';
import { MeshBuilder, addBox, addPrism, clampNum } from './builder';
import { MATERIALS, checkFaceBudget, type GeneratorResult } from './types';

/*
 * Multi-storey building: a closed wall shell whose facades are cut into a T-junction free grid
 * around recessed windows (reveal, frame ring, glass) and a front door, plus a FLAT (with
 * parapet), GABLE or HIP roof. The footprint is centred on the origin, the ground floor is at
 * z = 0 and the front facade (with the door) faces −Y.
 *
 * Slots: 0 Wall, 1 Window Glass, 2 Window Frame, 3 Roof, 4 Door.
 */

export type RoofType = 'FLAT' | 'GABLE' | 'HIP';

export interface BuildingParams {
  floors: number;
  /** Size along X in metres. */
  width: number;
  /** Size along Y in metres. */
  depth: number;
  /** Storey height in metres (wall height = floors × floor_height). */
  floor_height: number;
  /** Window columns on the front and back facades (null = automatic, about one per 2.5 m). */
  window_cols: number | null;
  /** Window columns on the left and right facades (null = automatic). */
  window_cols_side: number | null;
  /** Rows of windows per storey. */
  window_rows: number;
  window_width: number;
  window_height: number;
  /** Height of the window bottoms above each storey's floor. */
  sill_height: number;
  /** How deep windows (and the door) are recessed into the wall, in metres. */
  window_inset: number;
  /** Add a front door (centred on the front facade). */
  door: boolean;
  door_width: number;
  door_height: number;
  roof: RoofType;
  /** Ridge height above the walls for GABLE/HIP roofs (FLAT roofs get a parapet instead). */
  roof_height: number;
  /** Roof overhang beyond the walls in metres. */
  roof_overhang: number;
}

export const BUILDING_DEFAULTS: BuildingParams = {
  floors: 3,
  width: 10,
  depth: 8,
  floor_height: 3,
  window_cols: null,
  window_cols_side: null,
  window_rows: 1,
  window_width: 1.2,
  window_height: 1.4,
  sill_height: 0.9,
  window_inset: 0.12,
  door: true,
  door_width: 1.2,
  door_height: 2.2,
  roof: 'GABLE',
  roof_height: 2,
  roof_overhang: 0.4,
};

const WALL = 0;
const GLASS = 1;
const FRAME = 2;
const ROOF = 3;
const DOOR = 4;

interface Opening {
  s0: number;
  s1: number;
  t0: number;
  t1: number;
  door: boolean;
  /** Inner (recessed) corner vertices: bottom-left, bottom-right, top-right, top-left. */
  q?: number[];
}

interface Facade {
  origin: Vec3;
  u: Vec3;
  n: Vec3;
  length: number;
  openings: Opening[];
  ss: number[];
}

const EPS = 1e-6;

function uniqueSorted(values: number[]): number[] {
  const s = values.slice().sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) if (!out.length || v - out[out.length - 1] > EPS) out.push(v);
  return out;
}

export function generateBuilding(params: Partial<BuildingParams> = {}): GeneratorResult {
  const p = { ...BUILDING_DEFAULTS, ...params };
  const W = clampNum(p.width, 1, 1000, BUILDING_DEFAULTS.width);
  const D = clampNum(p.depth, 1, 1000, BUILDING_DEFAULTS.depth);
  const floors = Math.round(clampNum(p.floors, 1, 200, BUILDING_DEFAULTS.floors));
  const fh = clampNum(p.floor_height, 1, 100, BUILDING_DEFAULTS.floor_height);
  const H = floors * fh;
  const inset = clampNum(p.window_inset, 0.01, 2, BUILDING_DEFAULTS.window_inset);
  const facades: Facade[] = [
    { origin: [-W / 2, -D / 2, 0], u: [1, 0, 0], n: [0, -1, 0], length: W, openings: [], ss: [] },
    { origin: [W / 2, -D / 2, 0], u: [0, 1, 0], n: [1, 0, 0], length: D, openings: [], ss: [] },
    { origin: [W / 2, D / 2, 0], u: [-1, 0, 0], n: [0, 1, 0], length: W, openings: [], ss: [] },
    { origin: [-W / 2, D / 2, 0], u: [0, -1, 0], n: [-1, 0, 0], length: D, openings: [], ss: [] },
  ];
  const P = (f: Facade, s: number, t: number, d = 0): Vec3 => [
    f.origin[0] + f.u[0] * s - f.n[0] * d,
    f.origin[1] + f.u[1] * s - f.n[1] * d,
    t,
  ];

  // ---------------------------------------------------------------- openings
  const dw = Math.min(clampNum(p.door_width, 0.3, 100, 1.2), W - 1);
  const dh = Math.min(clampNum(p.door_height, 0.5, 100, 2.2), fh - 0.3);
  const hasDoor = p.door && dw >= 0.3 && dh >= 0.5;
  const door: Opening = { s0: W / 2 - dw / 2, s1: W / 2 + dw / 2, t0: 0, t1: dh, door: true };
  if (hasDoor) facades[0].openings.push(door);
  const rows = Math.round(clampNum(p.window_rows, 1, 10, 1));
  const sill = clampNum(p.sill_height, 0, fh, BUILDING_DEFAULTS.sill_height);
  const wh = clampNum(p.window_height, 0.1, 100, BUILDING_DEFAULTS.window_height);
  const band = fh - sill - 0.3;
  const winH = Math.min(wh, (band - 0.2 * (rows - 1)) / rows);
  const columns = facades.map((f, fi) => {
    const wanted = fi % 2 === 0 ? p.window_cols : p.window_cols_side;
    const cols = Math.round(
      wanted === null || wanted === undefined || !Number.isFinite(wanted)
        ? Math.max(1, Math.floor(f.length / 2.5))
        : clampNum(wanted, 0, 200, 0),
    );
    const ww = cols >= 1 ? Math.min(clampNum(p.window_width, 0.1, 100, 1.2), f.length / cols - 0.4) : 0;
    return cols < 1 || winH < 0.2 || ww < 0.25 ? { cols: 0, ww } : { cols, ww };
  });
  // fail before laying out the facades: every window column splits the facade grid twice and
  // every window adds about 25 faces (reveals, frame, glass, glazing bars)
  const windowsPerStorey = columns.reduce((s, c) => s + c.cols, 0) * rows;
  const gridLines = (cols: number) => 2 * cols + 2;
  checkFaceBudget(
    windowsPerStorey * floors * 25 +
      (2 * floors * rows + 2) * columns.reduce((s, c) => s + gridLines(c.cols), 0),
  );
  facades.forEach((f, fi) => {
    const { cols, ww } = columns[fi];
    if (cols < 1) return;
    const pitch = f.length / cols;
    for (let fl = 0; fl < floors; fl++)
      for (let r = 0; r < rows; r++) {
        const t0 = fl * fh + sill + r * (winH + 0.2);
        for (let c = 0; c < cols; c++) {
          const sc = (c + 0.5) * pitch;
          const o: Opening = { s0: sc - ww / 2, s1: sc + ww / 2, t0, t1: t0 + winH, door: false };
          if (hasDoor && fi === 0 && o.t0 < door.t1 + 0.2 && o.s1 > door.s0 - 0.3 && o.s0 < door.s1 + 0.3)
            continue;
          f.openings.push(o);
        }
      }
  });
  const zs = uniqueSorted([0, H, ...facades.flatMap((f) => f.openings.flatMap((o) => [o.t0, o.t1]))]);
  for (const f of facades) f.ss = uniqueSorted([0, f.length, ...f.openings.flatMap((o) => [o.s0, o.s1])]);

  const b = new MeshBuilder();
  const V = (f: Facade, s: number, t: number) => b.sharedVert(P(f, s, t));
  /** Index of the grid line at `v` (the first line not below v − EPS; every opening edge is a line). */
  const lineAt = (lines: readonly number[], v: number): number => {
    let lo = 0;
    let hi = lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid] < v - EPS) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  // ---------------------------------------------------------------- facade grid
  for (const f of facades) {
    // grid cells covered by an opening (looked up per opening, not tested per cell and opening)
    const nt = zs.length - 1;
    const covered = new Uint8Array(Math.max(0, f.ss.length - 1) * Math.max(0, nt));
    const span = new Map<Opening, { i0: number; i1: number; j0: number; j1: number }>();
    for (const o of f.openings) {
      const r = {
        i0: lineAt(f.ss, o.s0),
        i1: lineAt(f.ss, o.s1),
        j0: lineAt(zs, o.t0),
        j1: lineAt(zs, o.t1),
      };
      span.set(o, r);
      for (let i = r.i0; i < r.i1; i++) for (let j = r.j0; j < r.j1; j++) covered[i * nt + j] = 1;
    }
    for (let i = 0; i + 1 < f.ss.length; i++)
      for (let j = 0; j + 1 < zs.length; j++) {
        if (covered[i * nt + j]) continue;
        b.face(
          [
            V(f, f.ss[i], zs[j]),
            V(f, f.ss[i + 1], zs[j]),
            V(f, f.ss[i + 1], zs[j + 1]),
            V(f, f.ss[i], zs[j + 1]),
          ],
          WALL,
        );
      }
    for (const o of f.openings) {
      const cells = span.get(o)!;
      const sIn = f.ss.slice(cells.i0, cells.i1 + 1);
      const tIn = zs.slice(cells.j0, cells.j1 + 1);
      const Q = (s: number, t: number, d = inset) => b.vert(P(f, s, t, d));
      const q = [Q(o.s0, o.t0), Q(o.s1, o.t0), Q(o.s1, o.t1), Q(o.s0, o.t1)];
      o.q = q;
      const [qbl, qbr, qtr, qtl] = q;
      // reveals (outer edge follows the facade grid so no T-junctions appear)
      if (!o.door) b.face([...sIn.map((s) => V(f, s, o.t0)), qbr, qbl], WALL);
      b.face([...tIn.map((t) => V(f, o.s1, t)), qtr, qbr], WALL);
      b.face(
        [
          ...sIn
            .slice()
            .reverse()
            .map((s) => V(f, s, o.t1)),
          qtl,
          qtr,
        ],
        WALL,
      );
      b.face(
        [
          ...tIn
            .slice()
            .reverse()
            .map((t) => V(f, o.s0, t)),
          qbl,
          qtl,
        ],
        WALL,
      );
      const box = (s0: number, s1: number, t0: number, t1: number, d0: number, d1: number, mat: number) => {
        // facade-aligned box: local (s, t, depth) → world
        const m: Mat4 = [
          f.u[0],
          f.u[1],
          f.u[2],
          0,
          0,
          0,
          1,
          0,
          -f.n[0],
          -f.n[1],
          -f.n[2],
          0,
          f.origin[0],
          f.origin[1],
          0,
          1,
        ];
        addBox(b, [s0, t0, d0], [s1, t1, d1], { mat, matrix: m });
      };
      if (o.door) {
        b.face([qbl, qbr, qtr, qtl], DOOR);
        if (o.s1 - o.s0 > 0.5) box(o.s1 - 0.17, o.s1 - 0.1, 0.95, 1.05, inset - 0.06, inset, FRAME);
        continue;
      }
      const fw = Math.min(0.07, (o.s1 - o.s0) * 0.15, (o.t1 - o.t0) * 0.15);
      const gd = 0.04;
      const R = (s: number, t: number) => b.vert(P(f, s, t, inset));
      const G = (s: number, t: number) => b.vert(P(f, s, t, inset + gd));
      const r = [
        R(o.s0 + fw, o.t0 + fw),
        R(o.s1 - fw, o.t0 + fw),
        R(o.s1 - fw, o.t1 - fw),
        R(o.s0 + fw, o.t1 - fw),
      ];
      const g = [
        G(o.s0 + fw, o.t0 + fw),
        G(o.s1 - fw, o.t0 + fw),
        G(o.s1 - fw, o.t1 - fw),
        G(o.s0 + fw, o.t1 - fw),
      ];
      for (let k = 0; k < 4; k++) {
        const k1 = (k + 1) % 4;
        b.face([q[k], q[k1], r[k1], r[k]], FRAME); // frame ring
        b.face([r[k], r[k1], g[k1], g[k]], FRAME); // frame reveal down to the glass
      }
      b.face(g, GLASS);
      const bw = fw * 0.7;
      if (o.s1 - o.s0 > 0.9) {
        const sc = (o.s0 + o.s1) / 2;
        box(sc - bw / 2, sc + bw / 2, o.t0 + fw, o.t1 - fw, inset + 0.005, inset + gd, FRAME);
      }
      if (o.t1 - o.t0 > 1.2) {
        const tc = o.t0 + (o.t1 - o.t0) * 0.62;
        box(o.s0 + fw, o.s1 - fw, tc - bw / 2, tc + bw / 2, inset + 0.005, inset + gd, FRAME);
      }
    }
  }

  // ---------------------------------------------------------------- top and bottom faces
  const top: number[] = [];
  const bottom: number[] = [];
  for (const f of facades) {
    for (let i = 0; i + 1 < f.ss.length; i++) top.push(V(f, f.ss[i], H));
    for (let i = 0; i + 1 < f.ss.length; i++) {
      const s = f.ss[i];
      const d = f.openings.find((o) => o.door && Math.abs(o.s0 - s) < EPS);
      if (d?.q) {
        // notch around the recessed door
        bottom.push(V(f, d.s0, 0), d.q[0], d.q[1], V(f, d.s1, 0));
        while (i + 1 < f.ss.length && f.ss[i + 1] <= d.s1 + EPS) i++;
        continue;
      }
      bottom.push(V(f, s, 0));
    }
  }
  b.face(top, p.roof === 'FLAT' ? ROOF : WALL);
  b.face(bottom.slice().reverse(), WALL);

  // ---------------------------------------------------------------- roof
  const rh = clampNum(p.roof_height, 0.05, 1000, BUILDING_DEFAULTS.roof_height);
  const o = clampNum(p.roof_overhang, 0, 50, BUILDING_DEFAULTS.roof_overhang);
  if (p.roof === 'FLAT') {
    const pt = Math.min(0.25, W / 6, D / 6);
    const ph = 0.45;
    addBox(b, [-W / 2, -D / 2, H], [W / 2, -D / 2 + pt, H + ph], { mat: WALL });
    addBox(b, [-W / 2, D / 2 - pt, H], [W / 2, D / 2, H + ph], { mat: WALL });
    addBox(b, [-W / 2, -D / 2 + pt, H], [-W / 2 + pt, D / 2 - pt, H + ph], { mat: WALL });
    addBox(b, [W / 2 - pt, -D / 2 + pt, H], [W / 2, D / 2 - pt, H + ph], { mat: WALL });
  } else {
    const alongX = W >= D;
    const a = (alongX ? W : D) / 2; // half length along the ridge
    const s = (alongX ? D : W) / 2; // half span across the ridge
    const k = rh / s;
    const zEave = H - k * o;
    // canonical frame: ridge along +X; rotate by 90° about Z when the ridge runs along Y
    const cv = (x: number, y: number, z: number): Vec3 => (alongX ? [x, y, z] : [-y, x, z]);
    if (p.roof === 'GABLE') {
      const extrude: Mat4 = alongX
        ? [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1]
        : [-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
      const gable: Vec2[] = [
        [-s, H],
        [s, H],
        [0, H + rh],
      ];
      addPrism(b, gable, -a, a, { mat: WALL, matrix: extrude });
      const tt = Math.min(0.2, rh * 0.15 + 0.05);
      const slab: Vec2[] = [
        [-(s + o), zEave],
        [0, H + rh],
        [s + o, zEave],
        [s + o, zEave + tt],
        [0, H + rh + tt],
        [-(s + o), zEave + tt],
      ];
      addPrism(b, slab, -(a + o * 0.5), a + o * 0.5, { mat: ROOF, matrix: extrude });
    } else {
      const tf = Math.min(0.15, rh * 0.1 + 0.05);
      const corners: Vec2[] = [
        [-(a + o), -(s + o)],
        [a + o, -(s + o)],
        [a + o, s + o],
        [-(a + o), s + o],
      ];
      const eb = corners.map(([x, y]) => b.vert(cv(x, y, zEave - tf)));
      const et = corners.map(([x, y]) => b.vert(cv(x, y, zEave)));
      b.face([eb[3], eb[2], eb[1], eb[0]], ROOF);
      for (let i = 0; i < 4; i++) {
        const i1 = (i + 1) % 4;
        b.face([eb[i], eb[i1], et[i1], et[i]], ROOF);
      }
      const ridge = a - s;
      if (ridge > 1e-6) {
        const r1 = b.vert(cv(-ridge, 0, H + rh));
        const r2 = b.vert(cv(ridge, 0, H + rh));
        b.face([et[0], et[1], r2, r1], ROOF);
        b.face([et[1], et[2], r2], ROOF);
        b.face([et[2], et[3], r1, r2], ROOF);
        b.face([et[3], et[0], r1], ROOF);
      } else {
        const apex = b.vert(cv(0, 0, H + rh));
        for (let i = 0; i < 4; i++) b.face([et[i], et[(i + 1) % 4], apex], ROOF);
      }
    }
  }
  return {
    mesh: b.build(),
    materials: [MATERIALS.wall, MATERIALS.glass, MATERIALS.frame, MATERIALS.roof, MATERIALS.door],
  };
}
