import type { Vec3 } from '../math/types';

/*
 * Orientation frames along a sampled curve, used to sweep bevel profiles and to orient objects and
 * meshes following a curve. Every frame is orthonormal: `tangent` T (direction of travel), `up` U
 * (where a profile's +Y points, tilt applied) and `side` S = U × T (a profile's +X; for 2D curves
 * the left-hand side of the direction of travel, seen from +Z).
 */

export type TwistMode = 'Z_UP' | 'MINIMUM' | 'TANGENT';

export interface CurveFrames {
  tangents: Vec3[];
  ups: Vec3[];
  sides: Vec3[];
  /** Turn angle at each point (radians, 0 = straight, also at the ends of open curves). */
  turns: number[];
  /** Miter scale (≥ 1) applied along `kinks` so swept profiles keep their width through corners. */
  miters: number[];
  /** Unit direction in which the curve bends at each point (zero vector where it is straight). */
  kinks: Vec3[];
}

/** Largest miter scale (1 / cos(θ/2)); sharper corners are clipped like SVG's default miter limit. */
export const MITER_LIMIT = 4;

const Z: Vec3 = [0, 0, 1];

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function len(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
function norm(a: Vec3): Vec3 {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
/** Component of `v` perpendicular to unit `t`, normalised (zero when parallel). */
function perp(v: Vec3, t: Vec3): Vec3 {
  const d = dot(v, t);
  return norm([v[0] - d * t[0], v[1] - d * t[1], v[2] - d * t[2]]);
}
/** Rotates `v` around unit axis `k` by `angle` (Rodrigues). */
export function rotateAround(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [
    v[0] * c + kv[0] * s + k[0] * kd,
    v[1] * c + kv[1] * s + k[1] * kd,
    v[2] * c + kv[2] * s + k[2] * kd,
  ];
}

/** Up vector closest to +Z that is perpendicular to `t` (null when `t` is vertical). */
function zUp(t: Vec3): Vec3 | null {
  const u = perp(Z, t);
  return len(u) > 0.5 ? u : null;
}

/** Fills undefined (null) entries from the nearest defined neighbour, re-orthogonalised. */
function fillGaps(ups: (Vec3 | null)[], tangents: Vec3[]): Vec3[] {
  const n = ups.length;
  const first = ups.findIndex((u) => u !== null);
  const out: Vec3[] = new Array(n);
  if (first < 0) {
    // every tangent is vertical: any consistent horizontal axis will do
    for (let i = 0; i < n; i++) out[i] = perpOr([0, 1, 0], tangents[i]);
    return out;
  }
  for (let i = 0; i < n; i++) {
    const u = ups[i];
    if (u) out[i] = u;
    else if (i > 0 && out[i - 1]) out[i] = perpOr(out[i - 1], tangents[i]);
  }
  for (let i = first - 1; i >= 0; i--) out[i] = perpOr(out[i + 1], tangents[i]);
  return out;
}

function perpOr(prev: Vec3, t: Vec3): Vec3 {
  const u = perp(prev, t);
  if (len(u) > 0.5) return u;
  const a = perp([0, 1, 0], t);
  return len(a) > 0.5 ? a : perp([1, 0, 0], t);
}

/**
 * Frames at the points of a polyline (consecutive points must be distinct; at least 2 points).
 *
 * Tangents are bisectors of the adjacent segments. Up vectors follow Blender's twist modes:
 * Z_UP keeps them as close to +Z as possible, MINIMUM transports the first (Z-up) frame with
 * minimal rotation (double reflection; closed curves spread the closing mismatch along the length),
 * TANGENT uses the bending direction (binormal), flipped to stay continuous. Tilt then rotates the
 * frame around the tangent. 2D curves always use +Z as up and ignore tilt.
 */
export function computeFrames(
  points: readonly Vec3[],
  cyclic: boolean,
  tilts: readonly number[],
  mode: TwistMode,
  is2D: boolean,
): CurveFrames {
  const n = points.length;
  const segs = cyclic ? n : n - 1;
  const dirs: Vec3[] = [];
  const segLen: number[] = [];
  for (let i = 0; i < segs; i++) {
    const d = sub(points[(i + 1) % n], points[i]);
    segLen.push(len(d));
    dirs.push(norm(d));
  }
  const tangents: Vec3[] = [];
  const turns: number[] = [];
  const miters: number[] = [];
  const kinks: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const din = i > 0 ? dirs[i - 1] : cyclic ? dirs[segs - 1] : null;
    const dout = i < segs ? dirs[i] : null;
    if (din && dout) {
      let t = norm([din[0] + dout[0], din[1] + dout[1], din[2] + dout[2]]);
      if (len(t) === 0) t = dout; // hairpin: no bisector
      const c = Math.max(-1, Math.min(1, dot(din, dout)));
      const turn = Math.acos(c);
      tangents.push(t);
      turns.push(turn);
      const half = Math.cos(turn / 2);
      miters.push(half > 1 / MITER_LIMIT ? 1 / half : MITER_LIMIT);
      kinks.push(turn > 1e-9 ? perp(sub(dout, din), t) : [0, 0, 0]);
    } else {
      tangents.push(dout ?? din ?? [1, 0, 0]);
      turns.push(0);
      miters.push(1);
      kinks.push([0, 0, 0]);
    }
  }
  let ups: Vec3[];
  if (is2D) {
    ups = tangents.map((t) => {
      const u = perp(Z, t);
      return len(u) > 0.5 ? u : [0, 0, 1];
    });
  } else if (mode === 'Z_UP') {
    ups = fillGaps(tangents.map(zUp), tangents);
  } else if (mode === 'TANGENT') {
    const normals: (Vec3 | null)[] = tangents.map((t, i) => {
      const din = i > 0 ? dirs[i - 1] : cyclic ? dirs[segs - 1] : null;
      const dout = i < segs ? dirs[i] : null;
      if (!din || !dout) return null;
      const k = sub(dout, din);
      return len(k) > 1e-6 ? perp(k, t) : null;
    });
    // ends of open curves take the neighbouring bending direction
    if (!cyclic && n > 1) {
      const second = normals[1];
      const before = normals[n - 2];
      if (!normals[0] && second) normals[0] = perp(second, tangents[0]);
      if (!normals[n - 1] && before) normals[n - 1] = perp(before, tangents[n - 1]);
    }
    if (normals.every((x) => !x)) ups = minimumTwist(points, tangents, cyclic, segLen);
    else {
      const filled = fillGaps(normals, tangents);
      // keep the bending direction continuous (Blender flips tangents that reverse)
      for (let i = 1; i < n; i++)
        if (dot(filled[i], filled[i - 1]) < 0) filled[i] = [-filled[i][0], -filled[i][1], -filled[i][2]];
      ups = filled.map((nrm, i) => norm(cross(tangents[i], nrm)));
    }
  } else {
    ups = minimumTwist(points, tangents, cyclic, segLen);
  }
  const sides: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    let u = ups[i];
    const tilt = is2D ? 0 : (tilts[i] ?? 0);
    if (tilt) u = rotateAround(u, tangents[i], tilt);
    ups[i] = u;
    sides.push(norm(cross(u, tangents[i])));
  }
  return { tangents, ups, sides, turns, miters, kinks };
}

/** Rotation-minimizing frames (double reflection, Wang et al. 2008) starting from a Z-up frame. */
function minimumTwist(points: readonly Vec3[], tangents: Vec3[], cyclic: boolean, segLen: number[]): Vec3[] {
  const n = points.length;
  const start = fillGaps(tangents.map(zUp), tangents)[0];
  const ups: Vec3[] = [start];
  const transport = (r: Vec3, i: number, j: number): Vec3 => {
    const v1 = sub(points[j], points[i]);
    const c1 = dot(v1, v1);
    if (c1 < 1e-24) return perpOr(r, tangents[j]);
    const rL = sub(r, scale(v1, (2 / c1) * dot(v1, r)));
    const tL = sub(tangents[i], scale(v1, (2 / c1) * dot(v1, tangents[i])));
    const v2 = sub(tangents[j], tL);
    const c2 = dot(v2, v2);
    const next = c2 > 1e-24 ? sub(rL, scale(v2, (2 / c2) * dot(v2, rL))) : rL;
    return perpOr(next, tangents[j]);
  };
  for (let i = 1; i < n; i++) ups.push(transport(ups[i - 1], i - 1, i));
  if (cyclic && n > 2) {
    // distribute the twist needed to close the loop over the length (Blender corrects it too)
    const closing = transport(ups[n - 1], n - 1, 0);
    const t0 = tangents[0];
    const angle = Math.atan2(dot(cross(closing, start), t0), dot(closing, start));
    if (Math.abs(angle) > 1e-9) {
      let total = 0;
      for (const l of segLen) total += l;
      let acc = 0;
      for (let i = 1; i < n; i++) {
        acc += segLen[i - 1];
        const f = total > 0 ? acc / total : i / n;
        ups[i] = rotateAround(ups[i], tangents[i], angle * f);
      }
    }
  }
  return ups;
}

function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/**
 * Applies the corner miter of point `i` to an offset vector lying in its profile plane: the
 * component along the bending direction is stretched by the miter scale.
 */
export function applyMiter(frames: CurveFrames, i: number, v: Vec3): Vec3 {
  const m = frames.miters[i];
  if (m === 1) return v;
  const k = frames.kinks[i];
  const d = dot(v, k) * (m - 1);
  return [v[0] + k[0] * d, v[1] + k[1] * d, v[2] + k[2] * d];
}
