import type { Vec2, Vec3 } from '../math/types';
import type { EdgeAttr, MeshData } from '../mesh/types';
import { edgeKey } from '../mesh/types';
import type { CurveData, CurveFillMode } from '../doc/types';
import { evaluateCurveSplines } from './spline';
import { applyMiter, computeFrames, type CurveFrames, type TwistMode } from './frames';
import {
  extrudeProfile,
  objectBevelProfiles,
  profileExtent,
  roundBevelProfile,
  SHARP_ANGLE,
  type BevelFillType,
  type BevelProfile,
} from './bevel';
import { nestContours, signedArea, triangulatePolygon } from './fill';
import { textOutline } from './text';

export interface CurveMeshOptions {
  forRender: boolean;
  /** FONT objects: build the text in `body` instead of the splines. */
  isText: boolean;
  /** Bevel profile (bevel_mode OBJECT): closed/open 2D polylines of another curve object. */
  getBevelProfile?(curveObjectId: string): Vec2[][] | null;
  /**
   * Optional, preferred over `getBevelProfile`: the (animated) curve data of the bevel object, which
   * tells open and cyclic profile splines apart exactly.
   */
  getBevelCurve?(curveObjectId: string): CurveData | null;
  /**
   * Optional: the bevel object's (animated) X/Y object scale. Blender scales the profile by it, so
   * scaling the profile curve in Object Mode makes the tube thinner or wider.
   */
  getBevelScale?(curveObjectId: string): Vec2 | null;
}

export interface CurveMeshResult {
  /** Surface geometry (bevel, extrude, fill, text), null when the curve has none. */
  mesh: MeshData | null;
  /** Wire display of the splines as flat xyz segment pairs (object space). */
  lines: Float32Array | null;
  /** Problems met while building (invalid data is skipped or simplified, never thrown). */
  errors?: string[];
}

/** Largest surface (vertex count) built for one curve; denser requests fall back to wire display. */
const MAX_VERTICES = 3_000_000;
const EPS = 1e-9;

/** Wire segments of the sampled splines. */
export function curveLines(curve: CurveData, forRender = false): Float32Array | null {
  const segs: number[] = [];
  for (const s of evaluateCurveSplines(curve, forRender)) {
    const p = s.points;
    for (let i = 0; i + 1 < p.length; i++) segs.push(...p[i], ...p[i + 1]);
    if (s.cyclic && p.length > 2) segs.push(...p[p.length - 1], ...p[0]);
  }
  return segs.length ? new Float32Array(segs) : null;
}

// ------------------------------------------------------------------ settings

type Fill2D = 'NONE' | 'FRONT' | 'BACK' | 'BOTH';

interface Settings {
  is2D: boolean;
  depth: number;
  extrude: number;
  offset: number;
  resolution: number;
  factorStart: number;
  factorEnd: number;
  fill2D: Fill2D;
  bevelFill: BevelFillType;
  fillCaps: boolean;
  twist: TwistMode;
}

function finite(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Fill mode semantics follow Blender's flags: for 2D curves FULL/HALF behave like BOTH (filled),
 * for 3D curves BOTH is HALF and NONE is FULL.
 */
function readSettings(curve: CurveData, isText: boolean): Settings {
  const is2D = isText || curve.dimensions === '2D';
  const mode: CurveFillMode = curve.fill_mode;
  let fill2D: Fill2D = 'BOTH';
  if (mode === 'NONE') fill2D = 'NONE';
  else if (mode === 'FRONT') fill2D = 'FRONT';
  else if (mode === 'BACK') fill2D = 'BACK';
  let bevelFill: BevelFillType;
  if (is2D) bevelFill = fill2D === 'NONE' ? 'FULL' : fill2D === 'BOTH' ? 'HALF' : fill2D;
  else
    bevelFill =
      mode === 'HALF' || mode === 'BOTH'
        ? 'HALF'
        : mode === 'FRONT'
          ? 'FRONT'
          : mode === 'BACK'
            ? 'BACK'
            : 'FULL';
  const twist: TwistMode =
    curve.twist_mode === 'Z_UP' || curve.twist_mode === 'TANGENT' ? curve.twist_mode : 'MINIMUM';
  let factorStart = Math.min(1, Math.max(0, finite(curve.bevel_factor_start, 0)));
  let factorEnd = Math.min(1, Math.max(0, finite(curve.bevel_factor_end, 1)));
  if (factorStart > factorEnd) [factorStart, factorEnd] = [factorEnd, factorStart];
  return {
    is2D,
    depth: Math.max(0, finite(curve.bevel_depth, 0)),
    extrude: Math.max(0, finite(curve.extrude, 0)),
    offset: finite(curve.offset, 0),
    resolution: Math.max(0, Math.min(32, Math.round(finite(curve.bevel_resolution, 4)))),
    factorStart,
    factorEnd,
    fill2D,
    bevelFill,
    fillCaps: !!curve.use_fill_caps,
    twist,
  };
}

// ------------------------------------------------------------------ contours

/** A sampled spline (or glyph outline) ready to be swept / filled. */
interface Contour {
  points: Vec3[];
  tilts: number[];
  radii: number[];
  cyclic: boolean;
  material: number;
  smooth: boolean;
  /** Contours of the same group are nested together for 2D filling (one group per glyph). */
  group: number;
  /** Set for closed 2D contours that belong to a fill region. */
  filled?: boolean;
}

/** Removes repeated consecutive points (and a closing duplicate); demotes degenerate loops to open. */
function cleanContour(c: Contour): Contour | null {
  const pts: Vec3[] = [];
  const tilts: number[] = [];
  const radii: number[] = [];
  for (let i = 0; i < c.points.length; i++) {
    const p = c.points[i];
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) continue;
    const last = pts[pts.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) <= EPS) continue;
    pts.push(p);
    tilts.push(finite(c.tilts[i], 0));
    radii.push(Math.max(0, finite(c.radii[i], 1)));
  }
  let cyclic = c.cyclic;
  if (cyclic && pts.length > 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= EPS) {
      pts.pop();
      tilts.pop();
      radii.pop();
    }
  }
  if (pts.length < 3) cyclic = false;
  if (pts.length === 0) return null;
  return { ...c, points: pts, tilts, radii, cyclic };
}

function reverseContour(c: Contour): void {
  // keep the first point first so bevel factors still start at the same place
  const rev = <T>(a: T[]) => [a[0], ...a.slice(1).reverse()];
  c.points = rev(c.points);
  c.tilts = rev(c.tilts);
  c.radii = rev(c.radii);
}

const xy = (p: Vec3): Vec2 => [p[0], p[1]];

// ------------------------------------------------------------------ mesh building

class Builder {
  positions: number[] = [];
  faces: number[][] = [];
  faceMaterials: number[] = [];
  faceSmooth: boolean[] = [];
  uvs: number[][] = [];
  edgeAttrs: Record<string, EdgeAttr> = {};
  looseEdges: number[] = [];

  vertex(p: Vec3): number {
    this.positions.push(p[0], p[1], p[2]);
    return this.positions.length / 3 - 1;
  }
  face(verts: number[], material: number, smooth: boolean, uv: number[]): void {
    this.faces.push(verts);
    this.faceMaterials.push(material);
    this.faceSmooth.push(smooth);
    this.uvs.push(uv);
  }
  sharp(a: number, b: number): void {
    if (a !== b) this.edgeAttrs[edgeKey(a, b)] = { sharp: true };
  }
  pos(i: number): Vec3 {
    return [this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]];
  }
  build(): MeshData {
    return {
      positions: this.positions,
      faces: this.faces,
      faceMaterials: this.faceMaterials,
      faceSmooth: this.faceSmooth,
      uvs: this.uvs,
      colors: null,
      edgeAttrs: this.edgeAttrs,
      looseEdges: this.looseEdges,
    };
  }
}

interface Sample {
  pos: Vec3;
  tangent: Vec3;
  up: Vec3;
  side: Vec3;
  radius: number;
  /** Texture u (arc length fraction of the whole spline). */
  u: number;
  /** Index of the contour point (for miters and sharp corners), -1 for interpolated samples. */
  point: number;
}

interface SweepResult {
  /** Fill-cap boundary loops (vertex indices per contour point) at the profile's back/front points. */
  back: number[] | null;
  front: number[] | null;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

/** Arc length at every contour point and the total (closing segment included for cyclic contours). */
function arcLengths(c: Contour): { s: number[]; total: number } {
  const s = [0];
  const p = c.points;
  for (let i = 1; i < p.length; i++)
    s.push(s[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1], p[i][2] - p[i - 1][2]));
  let total = s[s.length - 1];
  if (c.cyclic) {
    const a = p[p.length - 1];
    total += Math.hypot(p[0][0] - a[0], p[0][1] - a[1], p[0][2] - a[2]);
  }
  return { s, total };
}

/** Sample at contour point `i`. */
function pointSample(c: Contour, f: CurveFrames, i: number, u: number): Sample {
  return {
    pos: c.points[i],
    tangent: f.tangents[i],
    up: f.ups[i],
    side: f.sides[i],
    radius: c.radii[i],
    u,
    point: i,
  };
}

/** Sample interpolated between contour points i and j (= i + 1, wrapping) at fraction t. */
function lerpSample(c: Contour, f: CurveFrames, i: number, j: number, t: number, u: number): Sample {
  const a = c.points[i];
  const b = c.points[j];
  const pos: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const tangent = normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
  const ua = f.ups[i];
  const ub = f.ups[j];
  let up: Vec3 = [ua[0] + (ub[0] - ua[0]) * t, ua[1] + (ub[1] - ua[1]) * t, ua[2] + (ub[2] - ua[2]) * t];
  const d = up[0] * tangent[0] + up[1] * tangent[1] + up[2] * tangent[2];
  up = normalize([up[0] - d * tangent[0], up[1] - d * tangent[1], up[2] - d * tangent[2]]);
  if (!up[0] && !up[1] && !up[2]) up = ua;
  const side = normalize(cross(up, tangent));
  const radius = c.radii[i] + (c.radii[j] - c.radii[i]) * t;
  return { pos, tangent, up, side, radius, u, point: -1 };
}

/**
 * Samples of the swept part of a contour (bevel_factor_start/end trim by arc length, unless `whole`).
 * Returns null when nothing remains; `closed` is true for untrimmed cyclic contours.
 */
function sweepSamples(
  c: Contour,
  f: CurveFrames,
  st: Settings,
  whole: boolean,
): { samples: Sample[]; closed: boolean } | null {
  const { s, total } = arcLengths(c);
  if (!(total > 0)) return null;
  const n = c.points.length;
  if (!whole && st.factorEnd - st.factorStart <= 1e-9) return null;
  const trimmed = !whole && (st.factorStart > 1e-9 || st.factorEnd < 1 - 1e-9);
  if (!trimmed)
    return { samples: c.points.map((_, i) => pointSample(c, f, i, s[i] / total)), closed: c.cyclic };
  const a = st.factorStart * total;
  const b = st.factorEnd * total;
  const segs = c.cyclic ? n : n - 1;
  const out: Sample[] = [];
  for (let k = 0; k < segs; k++) {
    const j = (k + 1) % n;
    const s0 = s[k];
    const s1 = k + 1 < n ? s[k + 1] : total;
    if (s1 <= a || s0 >= b) {
      if (s0 >= b) break;
      continue;
    }
    const span = s1 - s0 || 1;
    if (out.length === 0) {
      if (a > s0) out.push(lerpSample(c, f, k, j, (a - s0) / span, a / total));
      else out.push(pointSample(c, f, k, s0 / total));
    }
    if (b < s1) {
      out.push(lerpSample(c, f, k, j, (b - s0) / span, b / total));
      break;
    }
    // the end of this segment is inside the kept range
    if (j === 0) out.push({ ...pointSample(c, f, 0, 1), point: 0 });
    else out.push(pointSample(c, f, j, s1 / total));
  }
  return out.length >= 2 ? { samples: out, closed: false } : null;
}

/** Offset vector of profile point (x, y) in the frame of sample `sm`, mitered at corners. */
function profileOffset(sm: Sample, f: CurveFrames, x: number, y: number): Vec3 {
  let v: Vec3 = [sm.side[0] * x + sm.up[0] * y, sm.side[1] * x + sm.up[1] * y, sm.side[2] * x + sm.up[2] * y];
  if (sm.point >= 0) v = applyMiter(f, sm.point, v);
  return v;
}

/**
 * Sweeps one profile along a contour: walls, optional end caps, and the 2D fill-cap boundaries.
 * `whole` sweeps the full contour whatever the bevel factors (outlines of 2D fills).
 */
function sweep(
  b: Builder,
  c: Contour,
  f: CurveFrames,
  prof: BevelProfile,
  st: Settings,
  whole: boolean,
): SweepResult {
  const res: SweepResult = { back: null, front: null };
  const sw = sweepSamples(c, f, st, whole);
  if (!sw) return res;
  const { samples, closed } = sw;
  const m = prof.points.length;
  const extent = profileExtent(prof, st.offset);
  // one ring of vertices per sample (a single vertex where the radius collapses the profile)
  const rings: number[][] = samples.map((sm) => {
    if (sm.radius * extent <= EPS) {
      const v = b.vertex(sm.pos);
      return new Array<number>(m).fill(v);
    }
    return prof.points.map((p) => {
      const o = profileOffset(sm, f, p[0] + st.offset, p[1]);
      return b.vertex([
        sm.pos[0] + o[0] * sm.radius,
        sm.pos[1] + o[1] * sm.radius,
        sm.pos[2] + o[2] * sm.radius,
      ]);
    });
  });
  const collapsed = rings.map((r) => r.length > 1 && r[0] === r[1]);
  const segsAround = prof.closed ? m : m - 1;
  const segsAlong = closed ? samples.length : samples.length - 1;
  const smooth = c.smooth;
  for (let k = 0; k < segsAlong; k++) {
    const k2 = (k + 1) % samples.length;
    if (collapsed[k] && collapsed[k2]) continue;
    const ra = rings[k];
    const rb = rings[k2];
    const u0 = samples[k].u;
    const u1 = k2 === 0 ? 1 : samples[k2].u;
    for (let j = 0; j < segsAround; j++) {
      const j2 = (j + 1) % m;
      const v0 = prof.v[j];
      const v1 = j2 === 0 ? 1 : prof.v[j2];
      if (collapsed[k]) b.face([ra[j], rb[j2], rb[j]], c.material, smooth, [u0, v0, u1, v1, u1, v0]);
      else if (collapsed[k2]) b.face([ra[j], ra[j2], rb[j]], c.material, smooth, [u0, v0, u0, v1, u1, v0]);
      else b.face([ra[j], ra[j2], rb[j2], rb[j]], c.material, smooth, [u0, v0, u0, v1, u1, v1, u1, v0]);
    }
  }
  if (smooth) {
    // split shading at corners of the path and of the profile
    samples.forEach((sm, k) => {
      if (sm.point < 0 || f.turns[sm.point] <= SHARP_ANGLE || collapsed[k]) return;
      for (let j = 0; j < segsAround; j++) b.sharp(rings[k][j], rings[k][(j + 1) % m]);
    });
    prof.sharp.forEach((isSharp, j) => {
      if (!isSharp) return;
      for (let k = 0; k < segsAlong; k++) b.sharp(rings[k][j], rings[(k + 1) % samples.length][j]);
    });
  }
  // end caps of open sweeps (use_fill_caps)
  if (st.fillCaps && !closed && m >= 3) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of prof.points) {
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
    const w = x1 - x0 || 1;
    const h = y1 - y0 || 1;
    const uv = prof.points.flatMap((p) => [(p[0] - x0) / w, (p[1] - y0) / h]);
    const area = signedArea(prof.points);
    const ruv: number[] = [];
    for (let j = m - 1; j >= 0; j--) ruv.push(uv[j * 2], uv[j * 2 + 1]);
    // the walls run along the ring order, so the start cap is the reversed ring and the end cap the
    // ring itself: caps always agree with the walls (outward for counter-clockwise profiles)
    const cap = (k: number, forward: boolean) => {
      if (collapsed[k] || Math.abs(area) <= EPS) return;
      if (forward) b.face(rings[k].slice(), c.material, false, uv);
      else b.face(rings[k].slice().reverse(), c.material, false, ruv);
      if (smooth) for (let j = 0; j < m; j++) b.sharp(rings[k][j], rings[k][(j + 1) % m]);
    };
    cap(0, false);
    cap(samples.length - 1, true);
  }
  // 2D fill boundaries (only full, closed sweeps share their vertices with the caps)
  if (closed && samples.length === c.points.length) {
    if (prof.back >= 0) res.back = rings.map((r) => r[prof.back]);
    if (prof.front >= 0) res.front = rings.map((r) => r[prof.front]);
  }
  return res;
}

/**
 * New vertices along a closed contour pushed out by the profile point (x, y): caps of trimmed sweeps
 * (scaled by the point radius) and flat 2D fills (offset only, like Blender's width correction).
 */
function boundaryLoop(
  b: Builder,
  c: Contour,
  f: CurveFrames,
  x: number,
  y: number,
  useRadius: boolean,
): number[] {
  return c.points.map((p, i) => {
    const sm = pointSample(c, f, i, 0);
    const o = profileOffset(sm, f, x, y);
    const r = useRadius ? sm.radius : 1;
    return b.vertex([p[0] + o[0] * r, p[1] + o[1] * r, p[2] + o[2] * r]);
  });
}

/** Fills nested loops (outer + holes, vertex indices, XY plane) with faces facing +Z or −Z. */
function fillLoops(
  b: Builder,
  outer: number[],
  holes: number[][],
  facingUp: boolean,
  material: number,
  uvOf: (v: number) => [number, number],
): void {
  const pts = (loop: number[]) => loop.map((v) => xy(b.pos(v)));
  const outerXY = pts(outer);
  if (outer.length < 3) return;
  if (holes.length === 0) {
    // a single n-gon, wound for the requested facing
    const ccw = signedArea(outerXY) > 0;
    const loop = ccw === facingUp ? outer.slice() : outer.slice().reverse();
    b.face(
      loop,
      material,
      false,
      loop.flatMap((v) => uvOf(v)),
    );
    return;
  }
  const all = [outer, ...holes].flat();
  const tris = triangulatePolygon(outerXY, holes.map(pts));
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const tri = facingUp
      ? [all[tris[t]], all[tris[t + 1]], all[tris[t + 2]]]
      : [all[tris[t]], all[tris[t + 2]], all[tris[t + 1]]];
    b.face(
      tri,
      material,
      false,
      tri.flatMap((v) => uvOf(v)),
    );
  }
}

/** Profiles of the bevel object (bevel_mode OBJECT), scaled by the bevel object's X/Y scale. */
function objectProfiles(curve: CurveData, opts: CurveMeshOptions): BevelProfile[] {
  const id = curve.bevel_object;
  if (!id) return [];
  const sc = opts.getBevelScale?.(id);
  const sx = sc && Number.isFinite(sc[0]) ? sc[0] : 1;
  const sy = sc && Number.isFinite(sc[1]) ? sc[1] : 1;
  const scaled = (polys: Vec2[][]): Vec2[][] =>
    sx === 1 && sy === 1
      ? polys
      : polys.map((poly) =>
          Array.isArray(poly) ? poly.map((p) => (Array.isArray(p) ? ([p[0] * sx, p[1] * sy] as Vec2) : p)) : [],
        );
  const bc = opts.getBevelCurve?.(id);
  if (bc) {
    const splines = evaluateCurveSplines(bc, opts.forRender);
    return objectBevelProfiles(
      scaled(splines.map((s) => s.points.map((p): Vec2 => [p[0], p[1]]))),
      splines.map((s) => s.cyclic),
    );
  }
  const polys = opts.getBevelProfile?.(id);
  return polys ? objectBevelProfiles(scaled(polys)) : [];
}

/** Contours of a curve's splines or of a text's glyph outlines. */
function gatherContours(curve: CurveData, opts: CurveMeshOptions): Contour[] {
  const raw: Contour[] = [];
  if (opts.isText) {
    const t = textOutline(curve, opts.forRender);
    t.contours.forEach((loop, i) =>
      raw.push({
        points: loop.map((p): Vec3 => [p[0], p[1], 0]),
        tilts: loop.map(() => 0),
        radii: loop.map(() => 1),
        cyclic: true,
        material: 0,
        smooth: true,
        group: t.glyph[i],
      }),
    );
  } else {
    for (const s of evaluateCurveSplines(curve, opts.forRender))
      raw.push({
        points: s.points,
        tilts: s.tilts,
        radii: s.radii,
        cyclic: s.cyclic,
        material: s.materialIndex,
        smooth: s.smooth,
        group: 0,
      });
  }
  const out: Contour[] = [];
  for (const c of raw) {
    const cc = cleanContour(c);
    if (cc) out.push(cc);
  }
  return out;
}

interface Region {
  outer: number;
  holes: number[];
}

/**
 * 2D curves: nests closed contours per group (even-odd) and orients them so that the profile's +x
 * side (and positive offsets) point away from the filled area: outer boundaries clockwise, holes
 * counter-clockwise.
 */
function prepare2D(contours: Contour[]): Region[] {
  const groups = new Map<number, number[]>();
  contours.forEach((c, i) => {
    if (!c.cyclic) return;
    const g = groups.get(c.group);
    if (g) g.push(i);
    else groups.set(c.group, [i]);
  });
  const regions: Region[] = [];
  for (const ids of groups.values()) {
    const polys = ids.map((i) => contours[i].points.map(xy));
    const nest = nestContours(polys);
    nest.depth.forEach((d, k) => {
      if (d < 0) return;
      const c = contours[ids[k]];
      const ccw = signedArea(polys[k]) > 0;
      const hole = d % 2 === 1;
      if (ccw !== hole) reverseContour(c);
    });
    for (const r of nest.regions) {
      regions.push({ outer: ids[r.outer], holes: r.holes.map((h) => ids[h]) });
      contours[ids[r.outer]].filled = true;
      for (const h of r.holes) contours[ids[h]].filled = true;
    }
  }
  return regions;
}

function buildCurveMesh(curve: CurveData, opts: CurveMeshOptions): CurveMeshResult {
  const errors: string[] = [];
  const st = readSettings(curve, opts.isText);
  const contours = gatherContours(curve, opts);
  if (contours.length === 0) return { mesh: null, lines: null };

  let profiles: BevelProfile[] = [];
  if (curve.bevel_mode === 'OBJECT') {
    profiles = objectProfiles(curve, opts);
    if (curve.bevel_object && profiles.length === 0)
      errors.push(`bevel object '${curve.bevel_object}' is missing or has no usable profile`);
  } else {
    const p =
      st.depth > 0
        ? roundBevelProfile(st.depth, st.extrude, st.resolution, st.bevelFill)
        : extrudeProfile(st.extrude);
    if (p) profiles = [p];
  }

  let estimate = 0;
  for (const c of contours) for (const p of profiles) estimate += c.points.length * p.points.length;
  if (estimate > MAX_VERTICES) {
    errors.push(`curve surface too dense (${estimate} vertices); lower the resolution`);
    profiles = [];
  }

  const regions = st.is2D ? prepare2D(contours) : [];
  const b = new Builder();
  const frames = contours.map((c) =>
    c.points.length >= 2 ? computeFrames(c.points, c.cyclic, c.tilts, st.twist, st.is2D) : null,
  );
  const surfaced = contours.map(() => false);
  const capLoops: { back: number[] | null; front: number[] | null }[] = contours.map(() => ({
    back: null,
    front: null,
  }));

  // Outlines of 2D fill regions are swept whole when fill caps are built on them: the caps need the
  // complete outline (Blender ignores the bevel factors of cyclic splines altogether; here they
  // still trim unfilled closed curves, for "growing" outlines).
  const capsOnOutlines = st.is2D && st.fill2D !== 'NONE' && profiles.length > 0 && !profiles[0].closed;
  // swept surfaces (bevel / extrusion)
  contours.forEach((c, i) => {
    const f = frames[i];
    if (!f || profiles.length === 0) return;
    surfaced[i] = true;
    const whole = capsOnOutlines && !!c.filled;
    profiles.forEach((prof, k) => {
      const r = sweep(b, c, f, prof, st, whole);
      if (k === 0) capLoops[i] = r;
    });
  });

  // 2D fill: caps on top of the swept surface, or flat faces when there is no bevel / extrusion
  if (st.is2D && st.fill2D !== 'NONE' && regions.length) {
    const main = profiles[0];
    const wantBack = st.fill2D === 'BACK' || st.fill2D === 'BOTH';
    const wantFront = st.fill2D === 'FRONT' || st.fill2D === 'BOTH';
    const capped = main ? !main.closed : true;
    if (capped) {
      const loopsFor = (which: 'back' | 'front' | 'flat'): Map<number, number[]> => {
        const m = new Map<number, number[]>();
        for (const r of regions)
          for (const ci of [r.outer, ...r.holes]) {
            const c = contours[ci];
            const f = frames[ci];
            if (!f) continue;
            if (which === 'flat') {
              m.set(ci, boundaryLoop(b, c, f, st.offset, 0, false));
              continue;
            }
            const idx = which === 'back' ? main.back : main.front;
            if (idx < 0) continue;
            const shared = capLoops[ci][which];
            m.set(
              ci,
              shared ?? boundaryLoop(b, c, f, main.points[idx][0] + st.offset, main.points[idx][1], true),
            );
          }
        return m;
      };
      const jobs: { loops: Map<number, number[]>; up: boolean }[] = [];
      if (main) {
        // zero radius everywhere collapses the extrusion: front and back caps would coincide
        const thick = regions.some((r) =>
          [r.outer, ...r.holes].some((ci) => contours[ci].radii.some((x) => x > EPS)),
        );
        if (wantBack && main.back >= 0 && (thick || !wantFront || main.front < 0))
          jobs.push({ loops: loopsFor('back'), up: false });
        if (wantFront && main.front >= 0) jobs.push({ loops: loopsFor('front'), up: true });
      } else {
        // flat 2D fill: a single face set (Blender fills once), facing −Z only for BACK
        jobs.push({ loops: loopsFor('flat'), up: st.fill2D !== 'BACK' });
      }
      // texture space of the fill: bounding box of every cap vertex
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const j of jobs)
        for (const loop of j.loops.values())
          for (const v of loop) {
            const p = b.pos(v);
            x0 = Math.min(x0, p[0]);
            x1 = Math.max(x1, p[0]);
            y0 = Math.min(y0, p[1]);
            y1 = Math.max(y1, p[1]);
          }
      const w = x1 - x0 || 1;
      const h = y1 - y0 || 1;
      const uvOf = (v: number): [number, number] => {
        const p = b.pos(v);
        return [(p[0] - x0) / w, (p[1] - y0) / h];
      };
      for (const j of jobs)
        for (const r of regions) {
          const outer = j.loops.get(r.outer);
          if (!outer) continue;
          const holes = r.holes.map((h) => j.loops.get(h)).filter((l): l is number[] => !!l);
          fillLoops(b, outer, holes, j.up, contours[r.outer].material, uvOf);
        }
      if (!main) for (const r of regions) for (const ci of [r.outer, ...r.holes]) surfaced[ci] = true;
    }
  }

  // wires for everything without a surface (2D wires honour the offset, like Blender's width correction)
  const wirePoints: Vec3[][] = [];
  const wireCyclic: boolean[] = [];
  contours.forEach((c, i) => {
    if (surfaced[i] || c.points.length < 2) return;
    const f = frames[i];
    wirePoints.push(
      c.points.map((p, k) => {
        if (!st.is2D || !st.offset || !f) return p;
        const o = profileOffset(pointSample(c, f, k, 0), f, st.offset, 0);
        return [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
      }),
    );
    wireCyclic.push(c.cyclic);
  });
  const segs: number[] = [];
  wirePoints.forEach((pts, w) => {
    const n = pts.length;
    for (let i = 0; i + 1 < n; i++) segs.push(...pts[i], ...pts[i + 1]);
    if (wireCyclic[w] && n > 2) segs.push(...pts[n - 1], ...pts[0]);
  });
  const lines = segs.length ? new Float32Array(segs) : null;
  const extra = errors.length ? { errors } : {};
  if (b.faces.length === 0) return { mesh: null, lines, ...extra };
  // mixed surface + wire: the wires also become loose edges (kept by Convert to Mesh)
  wirePoints.forEach((pts, w) => {
    const ids = pts.map((p) => b.vertex(p));
    for (let i = 0; i + 1 < ids.length; i++) b.looseEdges.push(ids[i], ids[i + 1]);
    if (wireCyclic[w] && ids.length > 2) b.looseEdges.push(ids[ids.length - 1], ids[0]);
  });
  return { mesh: b.build(), lines, ...extra };
}

/**
 * Converts curve/text data to geometry (Blender's curve → mesh evaluation): bevel (ROUND with
 * bevel_depth / bevel_resolution, or the profile of `bevel_object`), extrusion, taper by point
 * radius, offset, bevel_factor_start/end, twist modes and tilt, 2D fill with even-odd holes
 * (front/back caps on extruded or beveled 2D curves), fill caps of open beveled curves, per-spline
 * material index and smooth shading (sharp edges at corners), UVs (u along the spline length,
 * v around the profile, fills mapped by their bounding box). FONT data builds its text with the
 * built-in font and is processed like a 2D curve. Never throws: problems are reported in `errors`.
 */
export function curveToMesh(curve: CurveData, opts: CurveMeshOptions): CurveMeshResult {
  try {
    return buildCurveMesh(curve, opts);
  } catch (e) {
    let lines: Float32Array | null = null;
    try {
      if (!opts.isText) lines = curveLines(curve, opts.forRender);
    } catch {
      lines = null;
    }
    return {
      mesh: null,
      lines,
      errors: [`curve evaluation failed: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
}

/**
 * A mesh for converting curve data to a mesh object (Blender's Convert → Mesh): the surface when
 * there is one, otherwise the wire as vertices and loose edges. Null when the curve is empty.
 */
export function curveToMeshData(curve: CurveData, opts: CurveMeshOptions): MeshData | null {
  const r = curveToMesh(curve, opts);
  if (r.mesh) return r.mesh;
  if (!r.lines || r.lines.length < 6) return null;
  const positions: number[] = [];
  const looseEdges: number[] = [];
  const index = new Map<string, number>();
  const vertexOf = (x: number, y: number, z: number): number => {
    const key = `${x},${y},${z}`;
    let v = index.get(key);
    if (v === undefined) {
      v = positions.length / 3;
      positions.push(x, y, z);
      index.set(key, v);
    }
    return v;
  };
  const l = r.lines;
  for (let i = 0; i + 5 < l.length; i += 6) {
    const a = vertexOf(l[i], l[i + 1], l[i + 2]);
    const c = vertexOf(l[i + 3], l[i + 4], l[i + 5]);
    if (a !== c) looseEdges.push(a, c);
  }
  return {
    positions,
    faces: [],
    faceMaterials: [],
    faceSmooth: [],
    uvs: null,
    colors: null,
    edgeAttrs: {},
    looseEdges,
  };
}
