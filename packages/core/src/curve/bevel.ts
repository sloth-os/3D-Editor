import type { Vec2 } from '../math/types';

/*
 * Bevel profiles: the 2D cross-section swept along a curve. Profile coordinates (x, y) map to the
 * curve frame's side (x) and up (y) axes. Closed profiles run counter-clockwise, open ones are built
 * so that the swept surface faces away from the profile's interior side, which gives outward normals.
 */

/** Which part of the round bevel is built (Blender's fill modes as they affect the bevel). */
export type BevelFillType = 'FULL' | 'HALF' | 'FRONT' | 'BACK';

export interface BevelProfile {
  points: Vec2[];
  closed: boolean;
  /** Texture v coordinate of each point (profile length fraction). */
  v: number[];
  /** Points where the profile has a corner (longitudinal edges there are marked sharp). */
  sharp: boolean[];
  /** Point bounding the back (bottom, −Z for 2D curves) fill cap, -1 when the profile has none. */
  back: number;
  /** Point bounding the front (top, +Z) fill cap, -1 when none. */
  front: number;
}

/** Corners sharper than this turn angle split shading (Blender's default auto smooth angle). */
export const SHARP_ANGLE = (30 * Math.PI) / 180;

function dedupe(points: Vec2[], closed: boolean): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) out.push(p);
  }
  if (closed && out.length > 2) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-9) out.pop();
  }
  return out;
}

/**
 * Completes a profile: texture v by length and the sharp points (turns above SHARP_ANGLE). `smooth`
 * profiles (sampled circles) have no sharp points at any resolution.
 */
function finish(
  points: Vec2[],
  closed: boolean,
  back: number,
  front: number,
  smooth = false,
): BevelProfile | null {
  const n = points.length;
  if (n < 2) return null;
  const v: number[] = [0];
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    v.push(total);
  }
  const full = closed
    ? total + Math.hypot(points[0][0] - points[n - 1][0], points[0][1] - points[n - 1][1])
    : total;
  for (let i = 0; i < n; i++) v[i] = full > 0 ? v[i] / full : i / Math.max(1, n - 1);
  const sharp = points.map((p, i) => {
    if (smooth || (!closed && (i === 0 || i === n - 1))) return false;
    const a = points[(i - 1 + n) % n];
    const b = points[(i + 1) % n];
    const d1 = [p[0] - a[0], p[1] - a[1]];
    const d2 = [b[0] - p[0], b[1] - p[1]];
    const l = Math.hypot(d1[0], d1[1]) * Math.hypot(d2[0], d2[1]);
    if (l === 0) return false;
    const c = (d1[0] * d2[0] + d1[1] * d2[1]) / l;
    return Math.acos(Math.max(-1, Math.min(1, c))) > SHARP_ANGLE;
  });
  return { points, closed, v, sharp, back, front };
}

/** Cosine / sine with exact zeros on the axes (avoids cos(π/2) ≈ 6e-17 drift). */
function axisExact(a: number): Vec2 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [Math.abs(c) < 1e-12 ? 0 : c, Math.abs(s) < 1e-12 ? 0 : s];
}

/**
 * Blender's ROUND bevel. Without extrusion the FULL profile is a plain circle of `4 + 2 × resolution`
 * points (Blender's full-circle special case; at angles k·2π/n, starting at the bottom). Otherwise
 * quarter circles of radius `depth` (`resolution + 1` segments each) surround the extrusion
 * (−extrude…+extrude along y): FULL is the closed loop; HALF the outer half (from the bottom over +x
 * to the top), FRONT / BACK only its upper / lower quarter plus the straight extruded side.
 */
export function roundBevelProfile(
  depth: number,
  extrude: number,
  resolution: number,
  fill: BevelFillType,
): BevelProfile | null {
  const r = Math.max(0, depth);
  const e = Math.max(0, extrude);
  if (!(r > 0)) return null;
  const q = Math.max(0, Math.min(32, Math.round(resolution)));
  if (fill === 'FULL' && e === 0) {
    const n = 4 + 2 * q;
    // Blender's points sit at multiples of 2π/n; start at (or just after) the bottom like the
    // quarter-based profiles, so the texture seam stays underneath
    const first = Math.ceil((3 * n) / 4);
    const pts: Vec2[] = [];
    for (let k = 0; k < n; k++) {
      const [c, s] = axisExact((((first + k) % n) * 2 * Math.PI) / n);
      pts.push([r * c, r * s]);
    }
    return finish(pts, true, -1, -1, true);
  }
  const arc = (cy: number, a0: number, a1: number): Vec2[] => {
    const out: Vec2[] = [];
    for (let k = 0; k <= q + 1; k++) {
      const [c, s] = axisExact(a0 + ((a1 - a0) * k) / (q + 1));
      out.push([r * c, cy + r * s]);
    }
    return out;
  };
  const H = Math.PI / 2;
  const bottomOuter = arc(-e, -H, 0);
  const topOuter = arc(e, 0, H);
  const topInner = arc(e, H, 2 * H);
  const bottomInner = arc(-e, 2 * H, 3 * H);
  switch (fill) {
    case 'FULL': {
      const pts = dedupe([...bottomOuter, ...topOuter, ...topInner, ...bottomInner], true);
      return finish(pts, true, -1, -1, true);
    }
    case 'HALF': {
      const pts = dedupe([...bottomOuter, ...topOuter], false);
      return finish(pts, false, 0, pts.length - 1, true);
    }
    case 'FRONT': {
      const pts = dedupe([[r, -e], ...topOuter], false);
      return finish(pts, false, -1, pts.length - 1, true);
    }
    case 'BACK': {
      const pts = dedupe([...bottomOuter, [r, e]], false);
      return finish(pts, false, 0, -1, true);
    }
  }
}

/** Extrusion without bevel: a straight line from −extrude to +extrude along y. */
export function extrudeProfile(extrude: number): BevelProfile | null {
  const e = Math.max(0, extrude);
  if (!(e > 0)) return null;
  return finish(
    [
      [0, -e],
      [0, e],
    ],
    false,
    0,
    1,
  );
}

function signedArea(p: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
}

/**
 * Profiles from another curve's sampled splines (bevel_mode OBJECT). The bevel object's local X axis
 * maps to the negative side axis and Y to up (Blender's mapping). `closed[i]` (the spline's cyclic
 * flag) decides exactly whether a polyline is closed; without it a polyline is taken to be closed when
 * its last point repeats the first one or when its closing gap is no longer than its longest segment
 * (cyclic splines are sampled without repeating their first point). Closed profiles are made
 * counter-clockwise (outward normals).
 */
export function objectBevelProfiles(
  polylines: readonly Vec2[][],
  closed?: readonly boolean[],
): BevelProfile[] {
  const out: BevelProfile[] = [];
  polylines.forEach((poly, i) => {
    const raw = poly
      .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map((p): Vec2 => [-p[0], p[1]]);
    let pts = dedupe(raw, false);
    if (pts.length < 2) return;
    const first = pts[0];
    const last = pts[pts.length - 1];
    const gap = Math.hypot(first[0] - last[0], first[1] - last[1]);
    let isClosed: boolean;
    if (closed && closed[i] !== undefined) isClosed = !!closed[i] && pts.length > 2;
    else if (gap <= 1e-9) isClosed = pts.length > 3;
    else {
      let longest = 0;
      for (let k = 1; k < pts.length; k++)
        longest = Math.max(longest, Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
      isClosed = pts.length > 2 && gap <= longest * 1.001;
    }
    if (isClosed) {
      pts = dedupe(pts, true);
      if (pts.length < 3) return;
      if (signedArea(pts) < 0) pts.reverse();
    }
    const prof = finish(pts, isClosed, isClosed ? -1 : 0, isClosed ? -1 : pts.length - 1);
    if (prof) out.push(prof);
  });
  return out;
}

/** Largest distance of a profile point from the profile origin (0 for none). */
export function profileExtent(p: BevelProfile, offset = 0): number {
  let m = 0;
  for (const q of p.points) m = Math.max(m, Math.hypot(q[0] + offset, q[1]));
  return m;
}
