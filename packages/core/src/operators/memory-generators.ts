import { clampNum } from '../generate/builder';

/*
 * Faces of the generated objects (object.generate_*) from their parameters, for the memory
 * estimates of operators/memory.ts: each count mirrors what its generator builds (core
 * generate/**), as an upper bound, without building anything. A test runs every generator with
 * random parameters and checks the counts against the meshes they build.
 */

const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);

/**
 * Parameters to lower for a smaller generated mesh, as the generators' own messages name them
 * (operators/generate.ts).
 */
export const GENERATOR_LOWER: Readonly<Record<string, string>> = {
  arch: 'segments',
  barrel: 'staves or hoops',
  blob: 'resolution',
  building: 'floors, window_rows, window_cols / window_cols_side, or width and depth',
  bush: 'density',
  chair: 'the chair parameters',
  cloud: 'resolution',
  column: 'segments or flutes',
  fence: 'the number of points or the path length, or raise post_spacing and picket_width / picket_gap',
  flower: 'petals',
  gear: 'teeth',
  grass_tuft: 'blades',
  pipe: 'the number of points, segments or bend_segments',
  rock: 'detail',
  shelf: 'shelves',
  spring: 'turns, resolution (path samples per turn) or wire_segments',
  stairs: 'steps',
  table: 'the table parameters',
  terrain: 'subdivisions',
  tree: 'branch_levels, branches, leaf_density or resolution',
  wheel: 'spokes or segments',
};

/**
 * Faces of the marching-cubes generators (blob, cloud) per (resolution + 2)² — the cells across the
 * sampled grid, `resolution` along its longest side and one of margin at each end: at most 10.0
 * measured (300 random blobs and clouds, resolution 8 to 160), doubled.
 */
export const ISOSURFACE_FACES_PER_CELL = 20;

/** Faces of a tube along `points` path points with `sides` around: rings of quads and two caps. */
const tube = (points: number, sides: number): number => Math.max(0, points - 1) * sides + 2;

/** DECIDUOUS, CONIFER and PALM trees (generate/vegetation.ts). */
function treeFaces(p: Record<string, unknown>): number {
  const levels = Math.round(clampNum(num(p.branch_levels), 1, 4, 3));
  const branches = Math.round(clampNum(num(p.branches), 1, 12, 4));
  const density = clampNum(num(p.leaf_density), 0, 1, 0.8);
  const res = Math.round(clampNum(num(p.resolution), 3, 64, 8));
  if (p.style === 'CONIFER') {
    // a trunk of 8 segments and branch_levels + 3 jagged tiers of 4 rings of 12–20 points
    const tiers = levels + 3;
    return tube(9, res) + (density > 0 ? tiers * 4 * (12 + 2 * Math.round(4 * density)) : 0);
  }
  if (p.style === 'PALM') {
    // a trunk of 24 segments, three coconuts (80-face icospheres) and fronds of 16–32 points
    const fronds = Math.max(3, Math.min(40, branches * 3));
    const points = 16 + Math.round(density * 16);
    return tube(25, res) + 3 * 80 + (density > 0 ? fronds * 4 * (points - 1) : 0);
  }
  // DECIDUOUS: a trunk of 8 segments, round(1.6 × branches) limbs on it and `branches` on every
  // other limb down to branch_levels, with fewer segments and sides per level; a leaf clump (an
  // 80-face icosphere) at up to two spots of each outermost limb and one of the level above
  let faces = tube(9, res);
  let limbs = 1;
  let spots = 0;
  for (let level = 1; level <= levels; level++) {
    limbs = level === 1 ? Math.max(2, Math.round(branches * 1.6)) : limbs * branches;
    faces += limbs * tube(Math.max(3, 7 - level) + 1, Math.max(3, res - 2 * level));
    if (level === levels) spots += 2 * limbs;
    else if (level === levels - 1) spots += limbs;
  }
  return faces + (density > 0 ? 80 * spots : 0);
}

/** Posts on the path, and per bay `rails` boxes (RAIL) or two rails and the pickets (generate/architecture.ts). */
function fenceFaces(p: Record<string, unknown>): number {
  const spacing = clampNum(num(p.post_spacing), 0.1, 1e3, 2);
  const pw = clampNum(num(p.post_width), 0.005, 10, 0.1);
  const pk = clampNum(num(p.picket_width), 0.005, 1, 0.08);
  const gap = clampNum(num(p.picket_gap), 0, 1, 0.05);
  const rails = Math.round(clampNum(num(p.rails), 1, 20, 2));
  const given = Array.isArray(p.points) ? (p.points as unknown[]) : [];
  const valid = given
    .filter(
      (q): q is number[] =>
        Array.isArray(q) && q.length >= 2 && (q as unknown[]).slice(0, 3).every(Number.isFinite),
    )
    .map((q) => [q[0], q[1]]);
  let path = valid.filter(
    (q, i) => i === 0 || Math.hypot(q[0] - valid[i - 1][0], q[1] - valid[i - 1][1]) > 1e-6,
  );
  if (given.length > 0 && path.length < 2) return 0;
  if (path.length < 2)
    path = [
      [0, 0],
      [clampNum(num(p.length), 0.1, 1e4, 6), 0],
    ];
  const closed = !!p.closed && path.length > 2;
  if (closed && Math.hypot(path[0][0] - path.at(-1)![0], path[0][1] - path.at(-1)![1]) < 1e-6) path.pop();
  const segs = closed ? path.length : path.length - 1;
  let posts = closed ? 0 : 1;
  let faces = 0;
  for (let s = 0; s < segs; s++) {
    const a = path[s];
    const c = path[(s + 1) % path.length];
    const length = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const k = Math.max(1, Math.ceil(length / spacing - 1e-9));
    posts += k;
    // k bays of length / k; a board is a 7-face pentagonal prism, a rail or post a 6-face box
    const pickets = Math.max(0, Math.floor((length / k - pw + gap) / (pk + gap) + 1e-6));
    faces += k * (p.style === 'RAIL' ? rails * 6 : 12 + 7 * pickets);
  }
  return faces + 6 * posts;
}

/** A helical wire: steps × sides quads and two caps (generate/mechanical.ts). */
function springFaces(p: Record<string, unknown>): number {
  const turns = clampNum(num(p.turns), 0.25, 500, 6);
  const res = Math.round(clampNum(num(p.resolution), 6, 256, 32));
  const sides = Math.floor(clampNum(num(p.wire_segments), 3, 64, 12));
  return tube(Math.max(8, Math.ceil(turns * res)) + 1, sides);
}

/** Path points of a pipe after its bends are rounded (generate/mechanical.ts filletPath), at most. */
function filletPoints(points: readonly number[][], segsPer90: number, cyclic: boolean): number {
  const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const pts = points.filter((q, i) => i === 0 || d(q, points[i - 1]) > 1e-9);
  if (cyclic) while (pts.length > 2 && d(pts[0], pts.at(-1)!) < 1e-9) pts.pop();
  const n = pts.length;
  if (n < 3) return n;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!(cyclic || (i > 0 && i < n - 1))) {
      count++;
      continue;
    }
    const a = pts[(i - 1 + n) % n];
    const q = pts[i];
    const c = pts[(i + 1) % n];
    const la = d(q, a) || 1;
    const lc = d(c, q) || 1;
    let dot = 0;
    for (let k = 0; k < 3; k++) dot += ((q[k] - a[k]) / la) * ((c[k] - q[k]) / lc);
    const theta = Math.acos(Math.min(1, Math.max(-1, dot)));
    count +=
      theta < 1e-3 || theta > Math.PI - 1e-3
        ? 1
        : Math.max(1, Math.ceil((theta / (Math.PI / 2)) * Math.max(1, segsPer90))) + 1;
  }
  return count;
}

/** A circle swept along the (rounded) path, twice for a hollow pipe, with its ends (generate/mechanical.ts). */
function pipeFaces(p: Record<string, unknown>): number {
  const given = Array.isArray(p.points) ? (p.points as unknown[]) : [];
  const pts = given
    .filter(
      (q): q is number[] => Array.isArray(q) && q.length >= 2 && (q as unknown[]).every(Number.isFinite),
    )
    .map((q) => [q[0], q[1], q[2] ?? 0]);
  const radius = clampNum(num(p.radius), 1e-4, 1e3, 0.1);
  const sides = Math.round(clampNum(num(p.segments), 3, 128, 16));
  const cyclic = !!p.cyclic && pts.length > 2;
  const bend = num(p.bend_radius) > 0;
  const points = bend ? filletPoints(pts, clampNum(num(p.bend_segments), 1, 64, 6), cyclic) : pts.length;
  const hollow = clampNum(num(p.thickness), 0, radius * 0.95, 0) > 0;
  return points * sides * (hollow ? 2 : 1) + 2 * sides + 2;
}

/**
 * Facades cut into a grid by the window and door edges (every facade has a line at each window's
 * top and bottom on any facade), up to 25 faces per window (reveals, frame, glass, glazing bars),
 * the door, the top and bottom, and the roof (generate/building.ts).
 */
function buildingFaces(p: Record<string, unknown>): number {
  const W = clampNum(num(p.width), 1, 1000, 10);
  const D = clampNum(num(p.depth), 1, 1000, 8);
  const floors = Math.round(clampNum(num(p.floors), 1, 200, 3));
  const fh = clampNum(num(p.floor_height), 1, 100, 3);
  const rows = Math.round(clampNum(num(p.window_rows), 1, 10, 1));
  const sill = clampNum(num(p.sill_height), 0, fh, 0.9);
  const wh = clampNum(num(p.window_height), 0.1, 100, 1.4);
  const winH = Math.min(wh, (fh - sill - 0.3 - 0.2 * (rows - 1)) / rows);
  const door = p.door !== false;
  const cols = [W, D, W, D].map((length, fi) => {
    const wanted = fi % 2 === 0 ? p.window_cols : p.window_cols_side;
    const c = Math.round(
      typeof wanted === 'number' && Number.isFinite(wanted)
        ? clampNum(wanted, 0, 200, 0)
        : Math.max(1, Math.floor(length / 2.5)),
    );
    const ww = c >= 1 ? Math.min(clampNum(num(p.window_width), 0.1, 100, 1.2), length / c - 0.4) : 0;
    return c < 1 || winH < 0.2 || ww < 0.25 ? 0 : c;
  });
  const windows = cols.reduce((a, c) => a + c, 0) * rows * floors;
  // grid lines: the ground, the top, the door's top and every window row's bottom and top
  const zLines = 3 + (windows ? 2 * rows * floors : 0);
  let cells = 0;
  cols.forEach((c, fi) => (cells += (1 + 2 * c + (fi === 0 && door ? 2 : 0)) * (zLines - 1)));
  return cells + 25 * windows + 100;
}

/** Faces of object.generate_<kind> with these (schema-filled) parameters, or null when not counted here. */
export function generatorFaces(kind: string, p: Record<string, unknown>): number | null {
  switch (kind) {
    case 'tree':
      return treeFaces(p);
    case 'fence':
      return fenceFaces(p);
    case 'spring':
      return springFaces(p);
    case 'pipe':
      return pipeFaces(p);
    case 'building':
      return buildingFaces(p);
    case 'arch':
      // the opening's curve (segments + 1 points, two arcs when POINTED), the piers and the crown
      // extruded: a quad per outline point and the two sides
      return Math.round(clampNum(num(p.segments), 4, 256, 24)) + 12;
    case 'terrain': {
      // a grid of subdivisions² quads; a solid one adds its skirt (4 per border cell) and a base
      // of one strip per column
      const s = Math.round(clampNum(num(p.subdivisions), 1, 1024, 64));
      return s * s + (p.solid ? 5 * s : 0);
    }
    case 'blob':
    case 'cloud': {
      const res = Math.round(clampNum(num(p.resolution), 8, 160, kind === 'blob' ? 48 : 56));
      return ISOSURFACE_FACES_PER_CELL * (res + 2) ** 2;
    }
    default:
      return null;
  }
}
