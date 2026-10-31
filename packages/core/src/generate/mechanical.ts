import type { Vec2, Vec3 } from '../math/types';
import { cross3, dot3, normalize3 } from '../math/vec3';
import {
  MeshBuilder,
  add,
  addRingSurface,
  addTube,
  clampNum,
  len,
  rotateAbout,
  scale,
  sub,
  tubeRings,
} from './builder';
import { MATERIALS, type GeneratorResult } from './types';

/*
 * Mechanical parts: spur gear, coil spring and pipe (circle swept along a filleted polyline).
 */

// ------------------------------------------------------------------ gear

export interface GearParams {
  /** Number of teeth (3..200). */
  teeth: number;
  /** Outer (tip) radius in metres. */
  radius: number;
  /** Radial tooth height in metres (tip radius − root radius). */
  tooth_depth: number;
  /** Thickness along the axis (Z) in metres. */
  thickness: number;
  /** Radius of the central bore hole in metres (0 = solid). */
  bore: number;
}

export const GEAR_DEFAULTS: GearParams = { teeth: 16, radius: 0.5, tooth_depth: 0.08, thickness: 0.1, bore: 0.1 };

/**
 * Spur gear lying in the XY plane, centred on the origin (z = ±thickness/2), axis = Z. Trapezoidal
 * teeth (wide root, narrow tip); with a bore the gear is a closed ring, otherwise a solid disc.
 */
export function generateGear(params: Partial<GearParams> = {}): GeneratorResult {
  const p = { ...GEAR_DEFAULTS, ...params };
  const teeth = Math.round(clampNum(p.teeth, 3, 200, GEAR_DEFAULTS.teeth));
  const rTip = clampNum(p.radius, 1e-3, 1e4, GEAR_DEFAULTS.radius);
  const depth = clampNum(p.tooth_depth, 0, rTip * 0.6, 0);
  const rRoot = Math.max(rTip * 0.05, rTip - depth);
  const t = clampNum(p.thickness, 1e-4, 1e4, GEAR_DEFAULTS.thickness);
  const bore = clampNum(p.bore, 0, rRoot * 0.9, 0);
  // one tooth period: gap middle, flank foot, tip start, tip end, flank foot
  const pitch = (2 * Math.PI) / teeth;
  const pattern: [number, number][] = [
    [-0.5, rRoot],
    [-0.27, rRoot],
    [-0.12, rTip],
    [0.12, rTip],
    [0.27, rRoot],
  ];
  const angles: number[] = [];
  const radii: number[] = [];
  for (let k = 0; k < teeth; k++)
    for (const [f, r] of pattern) {
      angles.push((k + f) * pitch);
      radii.push(depth > 0 ? r : rTip);
    }
  const ringAt = (rOf: (j: number) => number, z: number): Vec3[] =>
    angles.map((a, j) => [rOf(j) * Math.cos(a), rOf(j) * Math.sin(a), z]);
  const b = new MeshBuilder();
  const outerBot = ringAt((j) => radii[j], -t / 2);
  const outerTop = ringAt((j) => radii[j], t / 2);
  if (bore > 0) {
    // closed (r, z) loop: bore bottom → outer bottom → outer top → bore top
    addRingSurface(b, [ringAt(() => bore, -t / 2), outerBot, outerTop, ringAt(() => bore, t / 2)], {
      loop: true,
    });
  } else {
    addRingSurface(b, [[[0, 0, -t / 2]], outerBot, outerTop, [[0, 0, t / 2]]]);
  }
  return { mesh: b.build(), materials: [MATERIALS.steel] };
}

// ------------------------------------------------------------------ spring

export interface SpringParams {
  /** Radius of the coil (axis to wire centre) in metres. */
  coil_radius: number;
  /** Number of turns. */
  turns: number;
  /** Total height in metres. */
  height: number;
  /** Radius of the wire in metres. */
  wire_radius: number;
  /** Vertices around the wire. */
  wire_segments: number;
  /** Path samples per turn. */
  resolution: number;
  /** Close the end coils (zero pitch over the last half turn, like a compression spring). */
  closed_ends: boolean;
}

export const SPRING_DEFAULTS: SpringParams = {
  coil_radius: 0.2,
  turns: 6,
  height: 0.8,
  wire_radius: 0.02,
  wire_segments: 12,
  resolution: 32,
  closed_ends: true,
};

/** Helical coil spring around the Z axis standing on z = 0 (origin at the bottom centre). */
export function generateSpring(params: Partial<SpringParams> = {}): GeneratorResult {
  const p = { ...SPRING_DEFAULTS, ...params };
  const R = clampNum(p.coil_radius, 1e-3, 1e4, SPRING_DEFAULTS.coil_radius);
  const turns = clampNum(p.turns, 0.25, 500, SPRING_DEFAULTS.turns);
  const wr = clampNum(p.wire_radius, 1e-4, R * 0.9, SPRING_DEFAULTS.wire_radius);
  const H = Math.max(clampNum(p.height, 0, 1e4, SPRING_DEFAULTS.height), wr * 2 * 1.05);
  const res = Math.round(clampNum(p.resolution, 6, 256, 32));
  const steps = Math.max(8, Math.ceil(turns * res));
  const closedTurns = p.closed_ends ? Math.min(0.5, turns / 4) : 0;
  // height profile along the turn parameter: flat (closed) ends, constant pitch in between
  const z0 = wr;
  const z1 = H - wr;
  const active = turns - 2 * closedTurns;
  const endRise = p.closed_ends ? Math.min(2 * wr, (z1 - z0) / 4) : 0;
  const zAt = (u: number): number => {
    if (closedTurns <= 0) return z0 + ((z1 - z0) * u) / turns;
    if (u < closedTurns) return z0 + (endRise * u) / closedTurns;
    if (u > turns - closedTurns) return z1 - (endRise * (turns - u)) / closedTurns;
    return z0 + endRise + ((z1 - z0 - 2 * endRise) * (u - closedTurns)) / Math.max(1e-9, active);
  };
  const path: Vec3[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = (turns * i) / steps;
    const a = 2 * Math.PI * u;
    path.push([R * Math.cos(a), R * Math.sin(a), zAt(u)]);
  }
  const b = new MeshBuilder();
  addTube(b, path, wr, clampNum(p.wire_segments, 3, 64, 12), { smooth: true });
  return { mesh: b.build(), materials: [MATERIALS.steel] };
}

// ------------------------------------------------------------------ pipe

export interface PipeParams {
  /** Path points (object space, metres); at least two distinct points. */
  points: Vec3[];
  /** Outer radius in metres. */
  radius: number;
  /** Vertices around the pipe. */
  segments: number;
  /** Radius of the rounded bends at interior points (0 = sharp mitred corners). */
  bend_radius: number;
  /** Segments per 90° of bend. */
  bend_segments: number;
  /** Wall thickness for a hollow pipe (0 = solid). */
  thickness: number;
  /** Close the open ends with caps (solid) or rings (hollow). */
  closed_ends: boolean;
  /** Connect the last point back to the first (closed loop, no ends). */
  cyclic: boolean;
}

export const PIPE_DEFAULTS: PipeParams = {
  points: [
    [0, 0, 0],
    [2, 0, 0],
    [2, 2, 0],
    [2, 2, 1.5],
  ],
  radius: 0.1,
  segments: 16,
  bend_radius: 0.3,
  bend_segments: 6,
  thickness: 0,
  closed_ends: true,
  cyclic: false,
};

/** Rounds the interior corners of a polyline with circular arcs (fillets). */
export function filletPath(points: readonly Vec3[], radius: number, segsPer90: number, cyclic: boolean): Vec3[] {
  const pts = points.filter((q, i) => i === 0 || len(sub(q, points[i - 1])) > 1e-9);
  if (cyclic) while (pts.length > 2 && len(sub(pts[0], pts[pts.length - 1])) < 1e-9) pts.pop();
  const n = pts.length;
  if (radius <= 0 || n < 3) return pts.map((q) => [q[0], q[1], q[2]] as Vec3);
  const out: Vec3[] = [];
  const corner = (i: number) => cyclic || (i > 0 && i < n - 1);
  const turn = (i: number): number => {
    const din = normalize3(sub(pts[i], pts[(i - 1 + n) % n]));
    const dout = normalize3(sub(pts[(i + 1) % n], pts[i]));
    return Math.acos(clampNum(dot3(din, dout), -1, 1));
  };
  // wanted tangent length per corner (0 = keep the sharp point)
  const tl = pts.map((_, i) => {
    if (!corner(i)) return 0;
    const theta = turn(i);
    return theta < 1e-3 || theta > Math.PI - 1e-3 ? 0 : radius * Math.tan(theta / 2);
  });
  for (let i = 0; i < n; i++) {
    const q = pts[i];
    if (tl[i] <= 0) {
      out.push([q[0], q[1], q[2]]);
      continue;
    }
    const a = pts[(i - 1 + n) % n];
    const c = pts[(i + 1) % n];
    const din = normalize3(sub(q, a));
    const dout = normalize3(sub(c, q));
    const theta = turn(i);
    // a segment shared by two fillets is split in proportion to their wanted tangent lengths
    const share = (l: number, other: number) => (other > 0 ? (l * tl[i]) / (tl[i] + other) : l);
    const T = Math.min(tl[i], share(len(sub(q, a)), tl[(i - 1 + n) % n]), share(len(sub(c, q)), tl[(i + 1) % n]));
    const r = T / Math.tan(theta / 2);
    const start = sub(q, scale(din, T));
    const axis = normalize3(cross3(din, dout));
    const center = add(q, scale(normalize3(sub(dout, din)), r / Math.cos(theta / 2)));
    const k = Math.max(1, Math.ceil((theta / (Math.PI / 2)) * Math.max(1, segsPer90)));
    const rel = sub(start, center);
    for (let s = 0; s <= k; s++) out.push(add(center, rotateAbout(rel, axis, (theta * s) / k)));
  }
  return out.filter((q, i) => i === 0 || len(sub(q, out[i - 1])) > 1e-9);
}

/**
 * Pipe: a circle swept along `points` (object space) with rounded (or mitred) bends, optional wall
 * thickness and end caps. The object origin is the path's coordinate origin.
 */
export function generatePipe(params: Partial<PipeParams> = {}): GeneratorResult {
  const p = { ...PIPE_DEFAULTS, ...params };
  const pts = (p.points ?? []).filter((q) => Array.isArray(q) && q.length >= 2 && q.every(Number.isFinite));
  const path3: Vec3[] = pts.map((q) => [q[0], q[1], q[2] ?? 0]);
  const radius = clampNum(p.radius, 1e-4, 1e3, PIPE_DEFAULTS.radius);
  const sides = Math.round(clampNum(p.segments, 3, 128, 16));
  const cyclic = !!p.cyclic && path3.length > 2;
  const bend = p.bend_radius > 0 ? Math.max(clampNum(p.bend_radius, 0, 1e4, 0), radius * 1.05) : 0;
  const path = bend > 0 ? filletPath(path3, bend, clampNum(p.bend_segments, 1, 64, 6), cyclic) : path3;
  const b = new MeshBuilder();
  if (path.length < 2) return { mesh: b.build(), materials: [MATERIALS.metal] };
  const thickness = clampNum(p.thickness, 0, radius * 0.95, 0);
  const miter = bend <= 0;
  if (thickness <= 0) {
    addTube(b, path, radius, sides, { smooth: true, cyclic, caps: p.closed_ends, miter });
  } else {
    // hollow: outer surface, inverted inner surface, and annular end rings joining them
    const outer = tubeRings(path, radius, sides, { cyclic, miter });
    const inner = tubeRings(path, radius - thickness, sides, { cyclic, miter });
    if (outer && inner && outer.rings.length === inner.rings.length) {
      const o0 = b.vertexCount;
      addRingSurface(b, outer.rings, { smooth: true, loop: outer.cyclic, v: outer.v });
      const i0 = b.vertexCount;
      addRingSurface(b, inner.rings, { smooth: true, loop: inner.cyclic, v: inner.v, flip: true });
      if (!outer.cyclic && p.closed_ends) {
        const last = (outer.rings.length - 1) * sides;
        for (let j = 0; j < sides; j++) {
          const j1 = (j + 1) % sides;
          // start ring faces backwards, end ring forwards (rings run counter-clockwise seen from ahead)
          b.face([o0 + j1, o0 + j, i0 + j, i0 + j1]);
          b.face([o0 + last + j, o0 + last + j1, i0 + last + j1, i0 + last + j]);
        }
      }
    }
  }
  return { mesh: b.build(), materials: [MATERIALS.metal] };
}

/** Simple 2D helper used by other generators: regular polygon outline. */
export function circleOutline(r: number, n: number, a0 = 0): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + (2 * Math.PI * i) / n;
    out.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return out;
}
