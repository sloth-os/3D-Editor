import type { Mat4, Quat, Vec3 } from '../../math/types';
import { compose4, invert4, multiply4 } from '../../math/mat4';
import { fcurveKey, type SceneDoc } from '../../doc/scene-doc';
import type { FCurve, Keyframe, ObjectData } from '../../doc/types';
import { evaluateFCurve } from '../../anim/fcurve';
import { HIDDEN_SCALE_EPS, HIDE_SCALE, hiddenByScale, hiddenScale } from '../hide';
import { createCube, createCylinder } from '../../mesh/primitives';
import type { MeshData } from '../../mesh/types';
import type { FrameState } from '../../eval/frame-state';
import { OperatorError } from '../../operators/context';
import { getCatalogEntry } from '../../store/catalog';
import { mat3ToQuat, quatToMat3, slerpQ } from '../../physics/vmath';
import {
  baseName,
  channelsFor,
  descendants,
  keyTransforms,
  localBounds,
  originOf,
  parentMatrix,
  sceneSampler,
  silenceConstraintFrom,
  transformSamples,
  writeChannel,
  type TransformSamples,
} from './common';

/*
 * desk.tether_fly: a kite or a balloon flying on a string from an anchor (spec §4, phase 2), keyed on
 * every frame. The flyer is a point at its bridle (where the string is tied: the model's 'bridle' or
 * 'string_point' empty, else its origin) driven by the wind, gravity and, for a kite, aerodynamic
 * lift and drag, for a balloon buoyancy and drag. The string is inextensible: the flyer is never
 * farther from the anchor than its length, which pays out from the hand over launch_frames (the flyer
 * tugging a kite up when the wind alone climbs slower; with launch_frames 0 it is already flying on
 * the whole string at frame_start, where the mean wind holds it). The ground stops it: no corner of
 * its bounds goes below z = 0. The wind is steady with seeded gusts and lulls, so the same seed flies
 * the same flight. A kite settles where lift and drag balance its weight and the string's pull, 35–60°
 * above the horizon in a steady wind, and dips in the lulls; it faces the anchor (its front, −Y, along
 * the string), nose up. A tail of 4–6 damped segments trails from its bottom (the model's own 'tail'
 * parts when it has them) and a thin string object (desk_role 'string', a cylinder along its local +Z
 * from the anchor to the bridle) is keyed to join them; before the flight both shrink to a point.
 */

/** Air density (kg/m³). */
const AIR = 1.2;
/** Lift and drag coefficients of a flat kite at its trimmed angle of attack: tan(59°) ≈ C_L / C_D. */
const KITE_CL = 1.0;
const KITE_CD = 0.6;
/** Mass of a kite per m² of sail (kg), frame and tail included. */
const KITE_AREAL_MASS = 0.25;
/**
 * A balloon: the drag coefficient of a sphere, the lift of the helium per m³ of its bounding sphere
 * (N; air minus helium, the sphere about 70% filled) and the mass of its skin per m² (kg; a 28 cm
 * latex party balloon weighs about 5 g and lifts about 7 g more than that).
 */
const BALLOON_CD = 0.47;
const BALLOON_LIFT_PER_M3 = 9.81 * (1.2 - 0.17) * 0.7;
const BALLOON_MASS_PER_M2 = 0.02;
/** Integration steps per frame. */
const STEPS = 8;
/** Speed at which the string pays out during a default launch (m/s); a launch takes at least 2 s. */
const PAYOUT_MPS = 2.5;
const MIN_LAUNCH_SECONDS = 2;
/**
 * Climb rate of a kite on a paying-out line per m/s of air past it (0.22–0.26 measured). A launch
 * quicker than the wind climbs has the flyer tug the line (back off, run) for the missing air: none
 * in a calm (under the 2 m/s a kite needs to fly), decaying with a 0.5 s time constant once the line
 * is out.
 */
const CLIMB_PER_AIRSPEED = 0.22;
const TUG_FULL_WIND_MPS = 2;
const TUG_FADE_SECONDS = 0.5;
/** Most frames one flight keys, and most object frames (frames × keyed objects). */
export const TETHER_MAX_FRAMES = 20_000;
export const TETHER_MAX_OBJECT_FRAMES = 2_000_000;
/** Segments of a tail the preset makes (when the model has no tail of its own). */
export const TETHER_TAIL_SEGMENTS = 5;
/** Radius of the string object (m): thin, the renderers draw strings as lines at least 2 px wide. */
export const TETHER_STRING_RADIUS = 0.0015;
/**
 * Share of its shown scale an object a flight hides is keyed to on every axis (hide.ts HIDE_SCALE:
 * hiddenScale(shown)), and the scale of the string and a new tail before their first flight: they
 * shrink to a point (the 1 m string mesh to 1e-8 m), under the micrometre below which the export's
 * string overlay (apps/server render/passes.ts stringPolyline) draws nothing, so no dot shows where
 * the hand will be. A flyer shown at a tiny scale (a store model in very large units) shrinks as
 * much as any other.
 */
export const TETHER_HIDDEN_SCALE = HIDE_SCALE;

/** What a flight does with its flyer after frame_end: stays, is hidden, or comes down. */
export const TETHER_AFTER = ['hold', 'hide', 'land'] as const;
export type TetherAfter = (typeof TETHER_AFTER)[number];

/**
 * Seconds a kite takes at least to come down after its flight (after: 'land'); from higher up it takes
 * longer (tetherLandSeconds).
 */
export const TETHER_LAND_SECONDS = 1.5;
/**
 * How many times as long as a stone dropped from its height a landing kite takes to come down: its
 * sail holds it up, so it drifts down rather than falls (and touches the ground softly).
 */
export const TETHER_LAND_FALL_FACTOR = 1.6;
const GRAVITY = 9.81;

/**
 * Seconds a kite takes to come down from `height` metres above where it lands (its bridle's drop):
 * TETHER_LAND_FALL_FACTOR times a free fall's √(2h/g), at least TETHER_LAND_SECONDS. From the 17.7 m a
 * 20 m string flies it at, about 3 s (a fixed 1.5 s reached the ground at about 24 m/s, faster than a
 * dropped stone's 18.6 m/s).
 */
export function tetherLandSeconds(height: number): number {
  return Math.max(
    TETHER_LAND_SECONDS,
    TETHER_LAND_FALL_FACTOR * Math.sqrt((2 * Math.max(0, height)) / GRAVITY),
  );
}

/**
 * The most frames a landing after a flight on a `length_m` string from an anchor `anchorHeight` metres
 * up can take at `fps` (the kite can be no higher than the anchor and the string): what a flight
 * reserves, and desk.tether_fly's estimate counts, before the flight shows how high it ends.
 */
export function tetherLandFramesMax(length_m: number, anchorHeight: number, fps: number): number {
  return Math.max(1, Math.ceil(tetherLandSeconds(Math.max(0, anchorHeight) + Math.max(0, length_m)) * fps));
}

/**
 * tetherLandFramesMax for a flight of `length_m` from `anchor` (its bone `bone`) ending at `frameEnd`:
 * from the anchor's height at that frame (0 where it cannot be evaluated).
 */
export function tetherLandFrames(
  doc: SceneDoc,
  anchor: string,
  bone: string | undefined,
  frameEnd: number,
  length_m: number,
  fps: number,
): number {
  const a = anchorPoint(sceneSampler(doc).at(frameEnd), anchor, bone);
  return tetherLandFramesMax(length_m, a ? a[2] : 0, fps);
}
/** Seconds its tail is keyed on after it lies on the ground (the tail falls and lies down too). */
export const TETHER_TAIL_SETTLE_SECONDS = 1.5;
/** Share of its distance from the anchor a landing kite keeps (it dives toward the anchor). */
const LAND_REACH = 0.8;
/** Height of a landed kite's lowest corner above the ground (m). */
const LANDED_CLEARANCE = 0.005;
/**
 * Custom property of a flyer: the frames each of its flights keys, one 'lo:hi' span per flight in
 * frame order (lo = frame_start − 1, the key that holds what was there before it; hi = its last key,
 * frame_end + 1 when it hid the flyer), followed by 'h' when the flight hid the flyer (after: 'hide')
 * and 's' when the flyer was keyed shown at its start (an earlier flight had hidden it), and by
 * '@anchor' or '@anchor/bone' (URI-encoded: the anchor object's id and the bone the string is tied
 * to). A flight flown over an earlier one replaces that one's keys from its own start on; flights
 * apart keep theirs.
 */
const FLIGHTS = 'desk_tether_flights';
/** The property an earlier version kept on a flyer it hid (FLIGHTS replaces it): removed when flown. */
const LEGACY_HIDDEN_FROM = 'desk_tether_hidden_from';
/** Tolerance of key frames (anim/fcurve.ts insertKeyframe). */
const KEY_EPS = 1e-3;

/** Custom properties that tie the objects a flight adds to their flyer (so a second flight reuses them). */
const STRING_OF = 'desk_string_to';
const STRING_FROM = 'desk_string_from';
const TAIL_OF = 'desk_tail_of';

export interface TetherOptions {
  flyer: string;
  anchor: string;
  anchor_bone?: string;
  length_m: number;
  wind_dir_deg: number;
  wind_mps: number;
  frame_start: number;
  frame_end: number;
  launch_frames?: number;
  tail?: boolean;
  string?: boolean;
  seed?: number;
  /** What the flyer does after frame_end (default 'hold'; see {@link tetherFly}). */
  after?: TetherAfter;
}

export interface TetherResult {
  flyer: string;
  string: string | null;
  /** The first tail segment (null: no tail). */
  tail: string | null;
  tail_objects: string[];
  frame_end: number;
  kind: 'kite' | 'balloon';
  /** Seed of the gusts the flight used. */
  seed: number;
  /** Mean elevation of the bridle above the anchor after the launch (degrees). */
  mean_elevation_deg: number;
  /** What the flyer does after frame_end. */
  after: TetherAfter;
  /** First frame the flyer, its tail and its string are hidden (after: 'hide'), else null. */
  hidden_from: number | null;
  /** Last frame of a landing (after: 'land'): the kite lies on the ground from there, else null. */
  landed_frame: number | null;
  keyframes: number;
  warnings: string[];
}

// ---------------------------------------------------------------- small vector helpers

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3, fallback: Vec3 = [0, 0, 1]): Vec3 => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [...fallback];
};
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const transform = (m: Readonly<Mat4>, p: Readonly<Vec3>): Vec3 => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

/** A matrix from rotation columns, a scale per column and a translation. */
function frame(x: Vec3, y: Vec3, z: Vec3, scale: Vec3, origin: Vec3): Mat4 {
  return [
    x[0] * scale[0],
    x[1] * scale[0],
    x[2] * scale[0],
    0,
    y[0] * scale[1],
    y[1] * scale[1],
    y[2] * scale[1],
    0,
    z[0] * scale[2],
    z[1] * scale[2],
    z[2] * scale[2],
    0,
    origin[0],
    origin[1],
    origin[2],
    1,
  ];
}

/** Lengths of a matrix's first three columns (its scale, signs left out). */
const columnScale = (m: Readonly<Mat4>): Vec3 => [
  Math.hypot(m[0], m[1], m[2]) || 1,
  Math.hypot(m[4], m[5], m[6]) || 1,
  Math.hypot(m[8], m[9], m[10]) || 1,
];

/** A matrix's first three columns as unit vectors (its rotation, when it has no shear). */
const axesOf = (m: Readonly<Mat4>): [Vec3, Vec3, Vec3] => [
  norm([m[0], m[1], m[2]], [1, 0, 0]),
  norm([m[4], m[5], m[6]], [0, 1, 0]),
  norm([m[8], m[9], m[10]], [0, 0, 1]),
];

/** The quaternion of rotation columns (a right-handed orthonormal frame). */
const quatOfAxes = ([x, y, z]: [Vec3, Vec3, Vec3]): Quat =>
  mat3ToQuat([x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]]);

/** The rotation columns of a quaternion. */
function axesOfQuat(q: Readonly<Quat>): [Vec3, Vec3, Vec3] {
  const r = quatToMat3(q);
  return [
    [r[0], r[3], r[6]],
    [r[1], r[4], r[7]],
    [r[2], r[5], r[8]],
  ];
}

/** Whether a matrix mirrors (its first three columns are left-handed). */
const mirrors = (m: Readonly<Mat4>): boolean =>
  m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[4] * (m[1] * m[10] - m[2] * m[9]) +
    m[8] * (m[1] * m[6] - m[2] * m[5]) <
  0;

// ---------------------------------------------------------------- the wind

/** Deterministic PRNG (mulberry32) for the gusts. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed from a name (FNV-1a), so a flyer flies the same flight in every copy of the scene. */
export function seedFromName(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The wind as a function of time: a steady speed and direction with seeded gusts (three overlaid
 * swells of 3–14 s), lulls (dips to about half for 3–5 s every 15–30 s) and the direction swinging by
 * a few degrees. Its speed stays within 45–150% of the mean.
 */
export function windModel(seed: number, mps: number, dirDeg: number): (t: number) => Vec3 {
  const r = random(seed);
  const swell = [0, 1, 2].map((i) => ({
    period: 3 + r() * 11,
    phase: r() * Math.PI * 2,
    amp: [0.13, 0.09, 0.06][i],
  }));
  const lull = { period: 15 + r() * 15, phase: r() * Math.PI * 2 };
  const swing = [0, 1].map(() => ({ period: 6 + r() * 14, phase: r() * Math.PI * 2 }));
  const base = (dirDeg * Math.PI) / 180;
  return (t: number) => {
    let g = 1;
    for (const s of swell) g += s.amp * Math.sin((2 * Math.PI * t) / s.period + s.phase);
    const dip = Math.max(0, Math.sin((2 * Math.PI * t) / lull.period + lull.phase));
    g -= 0.5 * dip ** 4;
    g = Math.min(1.5, Math.max(0.45, g));
    const turn =
      ((8 * Math.PI) / 180) *
      (0.6 * Math.sin((2 * Math.PI * t) / swing[0].period + swing[0].phase) +
        0.4 * Math.sin((2 * Math.PI * t) / swing[1].period + swing[1].phase));
    const a = base + turn;
    // wind_dir_deg is where it blows to, about +Z: 0 toward −Y (the front), 90 toward +X
    return [Math.sin(a) * mps * g, -Math.cos(a) * mps * g, 0];
  };
}

// ---------------------------------------------------------------- the flyer

interface FlyerShape {
  kind: 'kite' | 'balloon';
  /** Where the string is tied, in the flyer's object space. */
  bridle: Vec3;
  /** Corners of the flyer's body (its parts but its own tail), in its object space: what the ground stops. */
  corners: Vec3[];
  /**
   * Corners of its main part's bounds (the mesh of largest area, its sail), in its object space: what
   * a landed kite rests on (its bridle lines and tail fold on the ground).
   */
  sail: Vec3[];
  /** Sail area (kite) or cross-section (balloon), m². */
  area: number;
  mass: number;
  /** Net upward force of a balloon (N). */
  lift: number;
  /** The flyer's two largest extents (its size). */
  size: number;
  /** Where a tail hangs from, in object space (the bottom of the flyer), and the model's tail parts. */
  tailAnchor: Vec3;
  tailParts: ObjectData[];
}

/** The eight corners of a box. */
const boxCorners = (b: { min: Vec3; max: Vec3 }): Vec3[] => {
  const out: Vec3[] = [];
  for (const cx of [b.min[0], b.max[0]])
    for (const cy of [b.min[1], b.max[1]]) for (const cz of [b.min[2], b.max[2]]) out.push([cx, cy, cz]);
  return out;
};

/**
 * Object-space bounds of a flyer's body, the flyer and its mesh parts (in the flyer's object space)
 * without its own tail (tail… parts and what hangs from them trail apart: a kite does not stand on
 * them; with them only when nothing else has a mesh), and those of its main part: the body's mesh
 * whose bounds have the largest area (its two largest extents). Null without meshes.
 */
function flyerBounds(
  doc: SceneDoc,
  fs: FrameState,
  flyer: ObjectData,
): { min: Vec3; max: Vec3; main: { min: Vec3; max: Vec3 } } | null {
  const inv = invert4(fs.world(flyer.id)!);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let main: { min: Vec3; max: Vec3; area: number } | null = null;
  // the flyer's body: its own tail (tail… parts and what hangs from them) trails apart, simulated
  const parts = [flyer, ...descendants(doc, flyer.id)];
  const byId = new Map(parts.map((o) => [o.id, o]));
  const tail = new Set<string>();
  for (const o of parts)
    for (let up: ObjectData | undefined = o; up && up.id !== flyer.id; up = byId.get(up.parent ?? ''))
      if (/^tail/i.test(baseName(up.name))) {
        tail.add(o.id);
        break;
      }
  const meshes = parts.filter((o) => o.type === 'MESH');
  const body = meshes.some((o) => !tail.has(o.id)) ? parts.filter((o) => !tail.has(o.id)) : parts;
  for (const o of body) {
    const b = o.type === 'MESH' ? localBounds(doc, o) : null;
    const w = fs.world(o.id);
    if (!b || !w) continue;
    const m = multiply4(inv, w);
    const lo: Vec3 = [Infinity, Infinity, Infinity];
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const c of boxCorners(b)) {
      const p = transform(m, c);
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], p[k]);
        hi[k] = Math.max(hi[k], p[k]);
      }
    }
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], lo[k]);
      max[k] = Math.max(max[k], hi[k]);
    }
    const ext = [0, 1, 2].map((k) => hi[k] - lo[k]).sort((x, y) => y - x);
    const area = ext[0] * ext[1];
    if (!main || area > main.area) main = { min: lo, max: hi, area };
  }
  if (!Number.isFinite(min[0])) return null;
  return { min, max, main: main ?? { min, max } };
}

/** The words that say what an object is (its name, label and store entry, its parents'). */
function identityWords(doc: SceneDoc, o: ObjectData): string {
  const words: string[] = [];
  for (
    let cur: ObjectData | null = o, i = 0;
    cur && i < 8;
    cur = cur.parent ? doc.getObject(cur.parent) : null, i++
  ) {
    words.push(cur.name);
    for (const k of ['desk_label', 'store_id'] as const) {
      const v = cur.custom_props?.[k];
      if (typeof v === 'string') {
        words.push(v);
        const e = k === 'store_id' ? getCatalogEntry(v) : null;
        if (e) words.push(e.name, ...e.tags);
      }
    }
  }
  return words.join(' ');
}

/** Natural order of names ('tail.2' before 'tail.10'). */
const naturally = (a: ObjectData, b: ObjectData): number =>
  a.name.localeCompare(b.name, undefined, { numeric: true });

function flyerShape(doc: SceneDoc, fs: FrameState, flyer: ObjectData): FlyerShape {
  const kind = flyerKind(doc, flyer);
  const world = fs.world(flyer.id)!;
  const inv = invert4(world);
  const parts = descendants(doc, flyer.id);
  const bridleObject = parts.find((p) => /^(bridle|string_point)$/i.test(baseName(p.name)));
  const bridleWorld = bridleObject ? fs.world(bridleObject.id) : null;
  const bridle: Vec3 = bridleWorld ? transform(inv, originOf(bridleWorld)) : [0, 0, 0];
  const fallback = { min: [-0.4, -0.05, -0.5] as Vec3, max: [0.4, 0.05, 0.5] as Vec3 };
  const b = flyerBounds(doc, fs, flyer) ?? { ...fallback, main: fallback };
  const scale = columnScale(world);
  const ext = [0, 1, 2].map((k) => (b.max[k] - b.min[k]) * scale[k]).sort((x, y) => y - x);
  const corners = boxCorners(b);
  const sail = boxCorners(b.main);
  const size = Math.max(0.1, ext[0]);
  const tailParts = tailPartsOf(doc, flyer);
  const tailAnchor: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.min[2]];
  if (kind === 'kite') {
    const area = Math.max(0.05, (ext[0] * ext[1]) / 2);
    return {
      kind,
      bridle,
      corners,
      sail,
      area,
      mass: KITE_AREAL_MASS * area,
      lift: 0,
      size,
      tailAnchor,
      tailParts,
    };
  }
  const radius = Math.max(0.05, ext[0] / 2);
  const area = Math.PI * radius * radius;
  const volume = (4 / 3) * Math.PI * radius ** 3;
  const mass = BALLOON_MASS_PER_M2 * 4 * area;
  return {
    kind,
    bridle,
    corners,
    sail,
    area,
    mass,
    lift: BALLOON_LIFT_PER_M3 * volume,
    size,
    tailAnchor,
    tailParts,
  };
}

/**
 * Elevation (rad) at which a flyer rests on its taut string in a steady wind of `mps` m/s: where the
 * string's pull balances the air and its weight. A kite: tan θ = (lift − weight) / drag; a balloon: its
 * buoyancy (lift − weight) over its drag, straight up in a calm. Null when the wind cannot hold it up.
 */
function steadyElevation(shape: FlyerShape, mps: number): number | null {
  const air = 0.5 * AIR * shape.area * mps * mps;
  const weight = 9.81 * shape.mass;
  if (shape.kind === 'kite') {
    const up = air * KITE_CL - weight;
    return up > 0 ? Math.atan2(up, air * KITE_CD) : null;
  }
  const up = shape.lift - weight;
  return up > 0 ? Math.atan2(up, air * BALLOON_CD) : null;
}

/** Rotation columns of a kite whose front (−Y) faces along `toAnchor`, nose up, rolled by `roll`. */
function kiteAxes(toAnchor: Vec3, roll: number): [Vec3, Vec3, Vec3] {
  const y = mul(norm(toAnchor, [0, 1, 0]), -1);
  let up = sub([0, 0, 1], mul(y, y[2]));
  if (len(up) < 1e-6) up = sub([1, 0, 0], mul(y, y[0]));
  let z = norm(up);
  let x = norm(cross(y, z));
  if (roll) {
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    const xr = add(mul(x, c), mul(z, s));
    z = add(mul(z, c), mul(x, -s));
    x = xr;
  }
  return [x, y, z];
}

/** Rotation columns of a balloon whose bottom (−Z) points along the string to the anchor. */
function balloonAxes(fromAnchor: Vec3, wind: Vec3): [Vec3, Vec3, Vec3] {
  const z = norm(fromAnchor);
  let x = cross(norm(wind, [0, -1, 0]), z);
  if (len(x) < 1e-6) x = cross([0, 1, 0], z);
  x = norm(x);
  return [x, cross(z, x), z];
}

/** Rotation columns that point an object's local −Z along `down` (a tail segment hanging from its top). */
function hangingAxes(down: Vec3, side: Vec3): [Vec3, Vec3, Vec3] {
  const z = mul(norm(down, [0, 0, -1]), -1);
  let x = sub(side, mul(z, dot(side, z)));
  if (len(x) < 1e-6) x = cross([0, 1, 0], z);
  if (len(x) < 1e-6) x = [1, 0, 0];
  x = norm(x);
  return [x, cross(z, x), z];
}

/**
 * `rest` (a world matrix) turned by the shortest rotation from direction `from` to `to` (unit
 * vectors), placed at `at`: a tail part following its chain while keeping how it hung at rest.
 */
function turnedWorld(rest: Readonly<Mat4>, from: Vec3, to: Vec3, at: Vec3): Mat4 {
  const axis = cross(from, to);
  const sin = len(axis);
  const cos = Math.max(-1, Math.min(1, dot(from, to)));
  let kx = 0;
  let ky = 0;
  let kz = 1;
  let angle = 0;
  if (sin > 1e-9) {
    [kx, ky, kz] = mul(axis, 1 / sin);
    angle = Math.atan2(sin, cos);
  } else if (cos < 0) {
    [kx, ky, kz] = norm(cross(from, Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    angle = Math.PI;
  }
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  const t = 1 - c;
  // Rodrigues, row-major
  const R = [
    c + kx * kx * t,
    kx * ky * t - kz * sn,
    kx * kz * t + ky * sn,
    ky * kx * t + kz * sn,
    c + ky * ky * t,
    ky * kz * t - kx * sn,
    kz * kx * t - ky * sn,
    kz * ky * t + kx * sn,
    c + kz * kz * t,
  ];
  const out = [...rest] as Mat4;
  for (let col = 0; col < 3; col++) {
    const v: Vec3 = [rest[col * 4], rest[col * 4 + 1], rest[col * 4 + 2]];
    for (let row = 0; row < 3; row++)
      out[col * 4 + row] = R[row * 3] * v[0] + R[row * 3 + 1] * v[1] + R[row * 3 + 2] * v[2];
  }
  out[12] = at[0];
  out[13] = at[1];
  out[14] = at[2];
  return out;
}

/** Rotation columns that point an object's local +Z along `dir` (the string). */
function alongAxes(dir: Vec3, previousX: Vec3): [Vec3, Vec3, Vec3] {
  const z = norm(dir);
  let x = sub(previousX, mul(z, dot(previousX, z)));
  if (len(x) < 1e-6) x = cross([0, 1, 0], z);
  if (len(x) < 1e-6) x = [1, 0, 0];
  x = norm(x);
  return [x, cross(z, x), z];
}

// ---------------------------------------------------------------- meshes of the added objects

/** A thin cylinder from z = 0 to z = 1 (scaled along Z to the string's length). */
function stringMesh(): MeshData {
  const m = createCylinder({ vertices: 6, radius: TETHER_STRING_RADIUS, depth: 1 });
  return { ...m, positions: m.positions.map((v, i) => (i % 3 === 2 ? v + 0.5 : v)) };
}

/** A ribbon segment hanging from z = 0 down to z = −length (a flat strip). */
function ribbonMesh(length: number, width: number): MeshData {
  const m = createCube({ size: 1 });
  const positions = m.positions.map((v, i) => {
    const axis = i % 3;
    if (axis === 0) return v * width;
    if (axis === 1) return v * 0.004;
    return (v - 0.5) * length;
  });
  return { ...m, positions };
}

// ---------------------------------------------------------------- the flight

/** The anchor point at a frame state: the anchor's origin, or the middle of its bone (a hand holding the string). */
function anchorPoint(fs: FrameState, anchor: string, bone: string | undefined): Vec3 | null {
  if (bone) {
    const b = fs.boneMatrix(anchor, bone);
    if (!b) return null;
    return transform(b.matrix, [0, b.length / 2, 0]);
  }
  const m = fs.world(anchor);
  return m ? originOf(m) : null;
}

/** The objects a previous flight of `flyer` added (its string and tail), to fly again. */
function previousParts(doc: SceneDoc, flyer: string): { string: ObjectData | null; tail: ObjectData[] } {
  let string: ObjectData | null = null;
  const tail: ObjectData[] = [];
  for (const o of doc.listObjects()) {
    if (o.custom_props?.[STRING_OF] === flyer) string ??= o;
    if (o.custom_props?.[TAIL_OF] === flyer) tail.push(o);
  }
  return { string, tail: tail.sort(naturally) };
}

/** A flight of a flyer, as its FLIGHTS property records it. */
interface Flight {
  /** frame_start − 1: the key that holds what was there before the flight. */
  lo: number;
  /** The flight's last key (frame_end + 1 when it hid the flyer). */
  hi: number;
  /** It hid the flyer after it (after: 'hide'): the scale keys at hi − 1 and hi. */
  hid: boolean;
  /** The flyer was keyed shown at its start (lo + 1), an earlier flight having hidden it. */
  showed: boolean;
  /** The anchor object's id and the bone the string is tied to (unknown for flights of earlier versions). */
  anchor?: string;
  bone?: string;
}

/** `text` decoded from a FLIGHTS entry (undefined when it is not valid URI encoding). */
function decoded(text: string | undefined): string | undefined {
  if (text === undefined || text === '') return undefined;
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/** The flights a flyer's FLIGHTS property records, in frame order (malformed entries skipped). */
function flightsOf(flyer: ObjectData): Flight[] {
  const text = flyer.custom_props?.[FLIGHTS];
  if (typeof text !== 'string') return [];
  const flights: Flight[] = [];
  for (const entry of text.split(/\s+/)) {
    const m = /^(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)([hs]*)(?:@([^/\s]+)(?:\/(\S+))?)?$/.exec(entry);
    if (!m || !(Number(m[2]) >= Number(m[1]))) continue;
    const anchor = decoded(m[4]);
    flights.push({
      lo: Number(m[1]),
      hi: Number(m[2]),
      hid: m[3].includes('h'),
      showed: m[3].includes('s'),
      ...(anchor ? { anchor, ...(decoded(m[5]) ? { bone: decoded(m[5]) } : {}) } : {}),
    });
  }
  return flights.sort((a, b) => a.lo - b.lo);
}

/** The FLIGHTS property text of `flights`. */
const flightsText = (flights: readonly Flight[]): string =>
  flights
    .map(
      (f) =>
        `${f.lo}:${f.hi}${f.hid ? 'h' : ''}${f.showed ? 's' : ''}` +
        (f.anchor ? `@${encodeURIComponent(f.anchor)}${f.bone ? `/${encodeURIComponent(f.bone)}` : ''}` : ''),
    )
    .join(' ');

/**
 * A string farther than this (m) from the point its flight ties it to is detached: the anchor moved
 * after the flight was keyed (desk.check's tether_detached; desk.actor_move and the other operators
 * that key an actor warn about it).
 */
export const TETHER_DETACH_M = 0.05;

/** A string of desk.tether_fly found detached from its anchor at some of the frames sampled. */
export interface TetherDetachment {
  string: string;
  flyer: string;
  /** The anchor object (id) and bone the flight governing those frames tied the string to. */
  anchor: string;
  bone?: string;
  /** The frames sampled where the string starts more than TETHER_DETACH_M from that point. */
  frames: number[];
  /** The largest distance found (m). */
  gap: number;
}

/**
 * The strings of the scene's desk.tether_fly flights that start more than TETHER_DETACH_M away from
 * the point their flight ties them to (the anchor's origin, or the middle of its bone) at any of
 * `frames`. A flight keys its string at the anchor point of each of its frames, and the string holds
 * where it was left after them: when the anchor moves later (desk.actor_move, a pose, a mount, a
 * prop it holds), the string stays behind, tied to nothing. Frames where a string is hidden (before
 * its first flight, put away after one) are not checked; `anchor` limits the check to the strings
 * tied to that object. Flights of earlier versions, which did not record their anchor, are checked
 * against the string's last anchor (any bone of an armature).
 */
export function tetherDetachments(
  doc: SceneDoc,
  frames: Iterable<number>,
  o: { anchor?: string } = {},
): TetherDetachment[] {
  // the strings, their flyers' flights and the anchor each flight tied them to
  const strings: { id: string; flyer: string; flights: Flight[]; anchors: (string | undefined)[] }[] = [];
  for (const s of doc.listObjects()) {
    const flyer = s.custom_props?.[STRING_OF];
    const flyerObject = typeof flyer === 'string' ? doc.getObject(flyer) : null;
    if (!flyerObject) continue;
    const last = s.custom_props?.[STRING_FROM];
    const flights = flightsOf(flyerObject);
    const anchors = flights.map((f) => f.anchor ?? (typeof last === 'string' ? last : undefined));
    if (o.anchor === undefined || anchors.includes(o.anchor))
      strings.push({ id: s.id, flyer: flyerObject.id, flights, anchors });
  }
  if (!strings.length) return [];
  const sampled = [...new Set([...frames].map(Math.round))].sort((a, b) => a - b);
  const sampler = sceneSampler(doc);
  const states = new Map<number, FrameState>();
  const at = (f: number): FrameState => {
    let fs = states.get(f);
    if (!fs) states.set(f, (fs = sampler.at(f)));
    return fs;
  };
  const out: TetherDetachment[] = [];
  for (const s of strings) {
    const found = new Map<string, TetherDetachment>();
    for (const f of sampled) {
      // the flight governing the frame: the last to start at or before it (a flight keys from lo + 1)
      let n = -1;
      for (let i = 0; i < s.flights.length; i++) if (s.flights[i].lo < f) n = i;
      if (n < 0) continue;
      const flight = s.flights[n];
      const anchor = s.anchors[n];
      if (!anchor || (o.anchor !== undefined && anchor !== o.anchor)) continue;
      const anchorObject = doc.getObject(anchor);
      if (!anchorObject) continue;
      const fs = at(f);
      const w = fs.world(s.id);
      if (!w || hiddenByScale(w)) continue;
      const start = originOf(w);
      let gap = Infinity;
      if (flight.anchor === undefined && anchorObject.type === 'ARMATURE') {
        // a flight of an earlier version: tied to one of the armature's bones, which it did not record
        for (const bone of fs.pose(anchor)?.bones.keys() ?? []) {
          const p = anchorPoint(fs, anchor, bone);
          if (p) gap = Math.min(gap, len(sub(start, p)));
        }
      } else {
        const p = anchorPoint(fs, anchor, flight.bone);
        if (p) gap = len(sub(start, p));
      }
      if (!(gap > TETHER_DETACH_M) || !Number.isFinite(gap)) continue;
      const key = `${anchor}/${flight.bone ?? ''}`;
      const d = found.get(key);
      if (d) {
        d.frames.push(f);
        d.gap = Math.max(d.gap, gap);
      } else
        found.set(key, {
          string: s.id,
          flyer: s.flyer,
          anchor,
          ...(flight.bone ? { bone: flight.bone } : {}),
          frames: [f],
          gap,
        });
    }
    out.push(...found.values());
  }
  return out;
}

/** The frames a flight keys (see Flight): `keyed` frames from frame_start, and frame_end + 1 unless it holds. */
function flightSpan(o: TetherOptions, keyed: number, after: TetherAfter): { lo: number; hi: number } {
  const last = o.frame_start + keyed - 1;
  return { lo: o.frame_start - 1, hi: after === 'hold' ? last : Math.max(last, o.frame_end + 1) };
}

/**
 * Keyframes of scale channel `fc` shown at `frame` when they hide it there (a scale under
 * HIDDEN_SCALE_EPS): a CONSTANT key there with the value it was last shown at before (`rest` when
 * never). Null when it is shown there already.
 */
function shownAt(fc: FCurve, keyframes: readonly Keyframe[], frame: number, rest: number): Keyframe[] | null {
  const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
  const v = evaluateFCurve({ ...fc, keyframes: sorted }, frame, sorted);
  if (v === undefined || Math.abs(v) >= HIDDEN_SCALE_EPS) return null;
  let value = rest;
  for (const k of sorted)
    if (k.frame < frame - KEY_EPS && Math.abs(k.value) >= HIDDEN_SCALE_EPS) value = k.value;
  const kept = sorted.filter((k) => Math.abs(k.frame - frame) >= KEY_EPS);
  return [...kept, { frame, value, interpolation: 'CONSTANT' as const }].sort((a, b) => a.frame - b.frame);
}

/**
 * Makes the flyer shown at `frameStart` for a flight from there (the flight samples its pose there):
 * the scale keys with which the flights it is flown over (`over`) hid it or showed it again go where
 * they are not before the flight, and a flyer an earlier flight hid is keyed shown from frameStart
 * (CONSTANT, at the scale it had before it was hidden). Returns how to put its scale back when the
 * flight fails, and whether it keyed it shown.
 */
function showFlyer(
  doc: SceneDoc,
  flyer: ObjectData,
  over: readonly Flight[],
  frameStart: number,
): { restore: () => void; showed: boolean } {
  const saved = [0, 1, 2].map((i) => doc.getFCurve(fcurveKey(scaleRef(flyer.id, i))) ?? null);
  const drop: number[] = [];
  for (const f of over) {
    if (f.hid && f.hi >= frameStart) drop.push(f.hi - 1, f.hi);
    if (f.showed && f.lo + 1 >= frameStart) drop.push(f.lo + 1);
  }
  let showed = false;
  for (let i = 0; i < 3; i++) {
    const fc = saved[i];
    if (!fc) continue;
    let keyframes = fc.keyframes.filter((k) => !drop.some((d) => Math.abs(k.frame - d) < KEY_EPS));
    const shown = shownAt(fc, keyframes, frameStart, flyer.scale[i]);
    if (shown) {
      keyframes = shown;
      showed = true;
    }
    if (keyframes.length === fc.keyframes.length && !shown) continue;
    if (keyframes.length) doc.setFCurve({ ...fc, keyframes });
    else doc.removeFCurve(fcurveKey(fc));
  }
  return {
    showed,
    restore: () => {
      for (let i = 0; i < 3; i++) {
        const fc = saved[i];
        if (fc) doc.setFCurve(fc);
        else doc.removeFCurve(fcurveKey(scaleRef(flyer.id, i)));
      }
    },
  };
}

/** The reference of an object's scale channel `index`. */
const scaleRef = (id: string, index: number) =>
  ({ target_type: 'object', target_id: id, path: 'scale', index }) as const;

/**
 * Keys object `id` hidden (hiddenScale: TETHER_HIDDEN_SCALE times its shown scale on every axis, its
 * sign kept) from frame `from` on, shown as `shown` up to it: a CONSTANT step, so no frame between
 * shows it shrinking. Later keys of the scale (an agent's own) are kept. Returns the keys written.
 */
function hideFrom(doc: SceneDoc, id: string, from: number, shown: Readonly<Vec3>): number {
  let keys = 0;
  for (let i = 0; i < 3; i++) {
    keys += writeChannel(doc, id, 'scale', i, [from - 1, from], [shown[i], hiddenScale(shown[i])], {
      interpolation: 'CONSTANT',
    });
  }
  return keys;
}

/**
 * Flies `o.flyer` on a string from `o.anchor` (see the module comment); keys the flyer, the string and
 * the tail on every frame of frame_start … frame_end (before that the flyer keeps its own animation:
 * its constraints, a hand holding it, stop acting at frame_start). After frame_end (`o.after`): 'hold'
 * leaves them where the flight ends; 'hide' hides the flyer (its parts and own tail with it), the
 * string and the tail from frame_end + 1 by their keyed scale (TETHER_HIDDEN_SCALE: renders, the
 * viewport and the video export's string overlay show nothing of them); 'land' brings a kite down
 * (tetherLandSeconds: longer from higher up; a nose-dive toward the anchor, its tail trailing
 * downwind) to lie flat on the ground, the string hidden from frame_end + 1. A flyer flies several
 * flights (its FLIGHTS property): each keys only its own frames, so an earlier flight's string and
 * tail keep theirs; one flown over an earlier one replaces that one from its own start on; between
 * two, the flyer, its string and its tail stay as the earlier one left them (hidden after 'hide').
 */
export function tetherFly(doc: SceneDoc, o: TetherOptions): TetherResult {
  const warnings: string[] = [];
  const flyer = doc.getObject(o.flyer);
  const anchorObject = doc.getObject(o.anchor);
  if (!flyer) throw new OperatorError(`Object '${o.flyer}' not found`, 'NOT_FOUND');
  if (!anchorObject) throw new OperatorError(`Object '${o.anchor}' not found`, 'NOT_FOUND');
  if (o.flyer === o.anchor) throw new OperatorError('The flyer cannot be its own anchor', 'INVALID_PARAMS');
  refusePartFlyer(doc, flyer);
  if (o.anchor_bone && anchorObject.type !== 'ARMATURE')
    throw new OperatorError(
      `anchor_bone needs an armature anchor ('${anchorObject.name}' is ${anchorObject.type})`,
      'INVALID_PARAMS',
    );
  if (!(o.frame_end > o.frame_start))
    throw new OperatorError(
      `frame_end (${o.frame_end}) must be after frame_start (${o.frame_start})`,
      'INVALID_PARAMS',
    );
  if (!(o.length_m > 0)) throw new OperatorError('length_m must be positive', 'INVALID_PARAMS');
  const after: TetherAfter = o.after ?? 'hold';
  if (!TETHER_AFTER.includes(after))
    throw new OperatorError(`after must be one of ${TETHER_AFTER.join(', ')}`, 'INVALID_PARAMS');
  const frames = o.frame_end - o.frame_start + 1;
  if (frames > TETHER_MAX_FRAMES)
    throw new OperatorError(
      `A flight of ${frames} frames is longer than ${TETHER_MAX_FRAMES}: fly a shorter range (frame_start, frame_end)`,
      'INVALID_PARAMS',
    );
  const fps = Math.max(1, doc.getScene().fps || 24);
  const kind = flyerKind(doc, flyer);
  if (after === 'land' && kind === 'balloon')
    throw new OperatorError(
      "A balloon does not come down: after 'hide' (or 'hold') puts it away after the flight",
      'INVALID_PARAMS',
    );
  // a landing takes longer from higher up: the most it can take (from the anchor's height at the
  // flight's end and the string's length; the flight shows how long it takes)
  const landFrames =
    after === 'land'
      ? tetherLandFrames(doc, anchorObject.id, o.anchor_bone, o.frame_end, o.length_m, fps)
      : 0;
  // a landed kite's tail falls after it and comes to lie on the ground downwind
  const settleFrames =
    after === 'land' && o.tail !== false ? Math.round(TETHER_TAIL_SETTLE_SECONDS * fps) : 0;
  const total = frames + landFrames + settleFrames;
  const wantTail = o.tail !== false && kind === 'kite';
  const ownTailParts = wantTail ? tailPartsOf(doc, flyer) : [];
  const segmentsPlanned = !wantTail
    ? 0
    : ownTailParts.length >= 2
      ? ownTailParts.length - 1
      : TETHER_TAIL_SEGMENTS;
  const keyed = 1 + (o.string === false ? 0 : 1) + segmentsPlanned;
  if (total * keyed > TETHER_MAX_OBJECT_FRAMES)
    throw new OperatorError(
      `Keying ${keyed} objects over ${total} frames is more than ${TETHER_MAX_OBJECT_FRAMES} object frames: fly a ` +
        'shorter range, or without the tail (tail: false)',
      'INVALID_PARAMS',
    );
  if (o.anchor_bone && !sceneSampler(doc).at(o.frame_start).boneMatrix(anchorObject.id, o.anchor_bone))
    throw new OperatorError(`Bone '${o.anchor_bone}' not found in '${anchorObject.name}'`, 'NOT_FOUND');
  // the flyer's earlier flights this one is flown over (it keys at most `total` frames: a landing
  // takes as long as its height asks); a flyer an earlier flight hid is shown for this one (put back
  // when the flight fails)
  const flights = flightsOf(flyer);
  const reach = flightSpan(o, total, after);
  const over = flights.filter((f) => f.lo <= reach.hi && f.hi >= reach.lo);
  const shown = showFlyer(doc, flyer, over, o.frame_start);
  try {
    return fly(doc, o, {
      flyer: doc.getObject(flyer.id)!,
      anchorObject,
      after,
      frames,
      landFrames,
      settleFrames,
      fps,
      warnings,
      flights,
      over,
      showed: shown.showed,
    });
  } catch (e) {
    shown.restore();
    throw e;
  }
}

/**
 * Refuses a flyer that is a part of something bigger: of a store model (an ancestor carries the
 * model's store_id: flying its sail alone would leave the spars and the model's own tail standing
 * on the ground, a second kite) or of an actor (its body parts).
 */
function refusePartFlyer(doc: SceneDoc, flyer: ObjectData): void {
  const actor = flyer.custom_props?.desk_actor;
  if (typeof actor === 'string' && actor && actor !== flyer.id) {
    const owner = doc.getObject(actor);
    throw new OperatorError(
      `'${flyer.name}' is a body part of the actor '${owner?.name ?? actor}': fly a prop (a kite or a balloon) instead`,
      'INVALID_PARAMS',
    );
  }
  if (typeof flyer.custom_props?.store_id === 'string') return;
  const seen = new Set<string>([flyer.id]);
  for (let id = flyer.parent; id && !seen.has(id);) {
    seen.add(id);
    const o = doc.getObject(id);
    if (!o) break;
    if (typeof o.custom_props?.store_id === 'string')
      throw new OperatorError(
        `'${flyer.name}' is part of the model '${o.name}': fly the model's root ('${o.name}'), so that ` +
          'all of it flies (its sail, spars and tail together)',
        'INVALID_PARAMS',
      );
    id = o.parent;
  }
}

/** Whether a flyer is a kite or a balloon (its name, label and store entry, or its parents'). */
function flyerKind(doc: SceneDoc, flyer: ObjectData): 'kite' | 'balloon' {
  return /balloon/i.test(identityWords(doc, flyer)) ? 'balloon' : 'kite';
}

/** The flyer's own tail parts ('tail…' objects under it), in their natural order. */
function tailPartsOf(doc: SceneDoc, flyer: ObjectData): ObjectData[] {
  return descendants(doc, flyer.id)
    .filter((p) => /^tail/i.test(baseName(p.name)))
    .sort(naturally);
}

/** The flight itself (see {@link tetherFly}), once its parameters are checked. */
function fly(
  doc: SceneDoc,
  o: TetherOptions,
  c: {
    flyer: ObjectData;
    anchorObject: ObjectData;
    after: TetherAfter;
    frames: number;
    /**
     * The most frames a landing can take (after: 'land': its time depends on the height the flight
     * ends at), and the frames its tail settles after it.
     */
    landFrames: number;
    settleFrames: number;
    fps: number;
    warnings: string[];
    /** The flyer's flights before this one (its FLIGHTS property), and those this one is flown over. */
    flights: readonly Flight[];
    over: readonly Flight[];
    /** showFlyer keyed the flyer shown at frame_start (an earlier flight had hidden it). */
    showed: boolean;
  },
): TetherResult {
  const { flyer, anchorObject, after, frames, settleFrames, fps, warnings } = c;
  // the frames keyed: the flight, its landing (as long as it turns out to take, at most c.landFrames)
  // and the tail settling after it
  let landFrames = 0;
  let total = frames + c.landFrames + settleFrames;
  const seed = o.seed ?? seedFromName(flyer.name);
  const sampler = sceneSampler(doc);
  const fs0 = sampler.at(o.frame_start);
  const flyerWorld0 = fs0.world(flyer.id);
  if (!flyerWorld0)
    throw new OperatorError(`'${flyer.name}' has no transform at frame ${o.frame_start}`, 'FAILED');
  const shape = flyerShape(doc, fs0, flyer);
  const wantTail = o.tail !== false && shape.kind === 'kite';
  if (o.tail !== false && shape.kind === 'balloon') warnings.push('balloons fly without a tail');
  const ownTail = wantTail && shape.tailParts.length >= 2;
  const segments = !wantTail ? 0 : ownTail ? shape.tailParts.length - 1 : TETHER_TAIL_SEGMENTS;

  // the anchor on every frame of the flight, and the flyer's parent on every keyed frame
  const anchors: Vec3[] = [];
  const flyerParents: (Mat4 | null)[] = [];
  for (let f = o.frame_start; f < o.frame_start + total; f++) {
    const fs = f === o.frame_start ? fs0 : sampler.at(f);
    flyerParents.push(parentMatrix(fs, flyer));
    if (f > o.frame_end) continue;
    const a = anchorPoint(fs, anchorObject.id, o.anchor_bone);
    if (!a)
      throw new OperatorError(
        o.anchor_bone
          ? `Bone '${o.anchor_bone}' not found in '${anchorObject.name}'`
          : `'${anchorObject.name}' has no transform at frame ${f}`,
        o.anchor_bone ? 'NOT_FOUND' : 'FAILED',
      );
    anchors.push(a);
  }
  const anchorAt = (t: number): Vec3 => {
    const i = Math.min(anchors.length - 1, Math.max(0, Math.floor(t)));
    const j = Math.min(anchors.length - 1, i + 1);
    return lerp3(anchors[i], anchors[j], t - i);
  };

  const L = o.length_m;
  const launchFrames = Math.max(
    0,
    Math.min(frames - 1, o.launch_frames ?? Math.round(fps * Math.max(MIN_LAUNCH_SECONDS, L / PAYOUT_MPS))),
  );
  const wind = windModel(seed, o.wind_mps, o.wind_dir_deg);
  const downwind = norm([
    Math.sin((o.wind_dir_deg * Math.PI) / 180),
    -Math.cos((o.wind_dir_deg * Math.PI) / 180),
    0,
  ]);
  const flyerScale = columnScale(flyerWorld0);
  const bridleOffset: Vec3 = [
    shape.bridle[0] * flyerScale[0],
    shape.bridle[1] * flyerScale[1],
    shape.bridle[2] * flyerScale[2],
  ];
  /** The flyer's world matrix with rotation columns `axes` and its bridle at `at`. */
  const placed = (axes: [Vec3, Vec3, Vec3], at: Vec3): Mat4 => {
    const [x, y, z] = axes;
    const rotated = add(add(mul(x, bridleOffset[0]), mul(y, bridleOffset[1])), mul(z, bridleOffset[2]));
    return frame(x, y, z, flyerScale, sub(at, rotated));
  };

  // the flyer's world matrix with its bridle at `at`, facing the anchor `a` (kite) or along the string (balloon)
  let lateral = 0;
  const poseAt = (at: Vec3, a: Vec3, t: number): { world: Mat4; x: Vec3 } => {
    // a flyer held at the anchor itself faces upwind (toward where the anchor will be)
    const toAnchor = len(sub(a, at)) > 0.05 ? sub(a, at) : mul(downwind, -1);
    let axes: [Vec3, Vec3, Vec3];
    if (shape.kind === 'kite') {
      const roll = Math.max(-0.5, Math.min(0.5, (0.35 * lateral) / Math.max(1, o.wind_mps)));
      axes = kiteAxes(toAnchor, roll);
    } else axes = balloonAxes(mul(toAnchor, -1), wind(t));
    return { world: placed(axes, at), x: axes[0] };
  };
  /** Lowest point of the flyer (its bounds' corners) in a world pose. */
  const lowest = (world: Readonly<Mat4>): number =>
    Math.min(...shape.corners.map((c) => transform(world, c)[2]));
  /** Height of the bridle above the flyer's lowest point, posed at `at` (the ground stops that point at z = 0). */
  const clearanceAt = (at: Vec3, a: Vec3, t: number): number => at[2] - lowest(poseAt(at, a, t).world);

  // the flight starts where the flyer is (held at the anchor, so it does not jump at frame_start); one
  // farther away than the string reaches starts on the string, toward where it was
  const a0 = anchors[0];
  let p = transform(flyerWorld0, shape.bridle);
  const startDistance = len(sub(p, a0));
  if (startDistance > L) p = add(a0, mul(sub(p, a0), L / startDistance));
  // launch_frames 0: already flying at frame_start (a flight going on from an earlier shot), where the
  // mean wind holds it on the taut string, downwind of the anchor; one the wind cannot hold up starts
  // where it is
  const steady = launchFrames === 0 ? steadyElevation(shape, o.wind_mps) : null;
  if (steady !== null) p = add(a0, mul(add(mul(downwind, Math.cos(steady)), [0, 0, Math.sin(steady)]), L));
  p[2] = Math.max(p[2], clearanceAt(p, a0, 0));
  const lineStart = Math.min(L, Math.max(len(sub(p, a0)), 0.3));
  let v: Vec3 = [0, 0, 0];
  const dt = 1 / (fps * STEPS);
  const k = 0.5 * AIR * shape.area;

  // the tail: node 0 hangs from the flyer (its own first tail part, else its bottom), the others trail
  const tailNodes: Vec3[] = [];
  const tailPrev: Vec3[] = [];
  const tailLengths: number[] = [];
  const tailLocalAnchor: Vec3 = ownTail
    ? transform(invert4(flyerWorld0), originOf(fs0.world(shape.tailParts[0].id)!))
    : shape.tailAnchor;
  /** Own tail parts: their rest world matrix and the chain direction they hung along at rest. */
  const restParts: { world: Mat4; dir: Vec3 }[] = [];
  if (segments) {
    if (ownTail) {
      for (const part of shape.tailParts) tailNodes.push(originOf(fs0.world(part.id)!));
      for (let i = 1; i < tailNodes.length; i++) {
        tailLengths.push(Math.max(0.01, len(sub(tailNodes[i], tailNodes[i - 1]))));
        restParts.push({
          world: fs0.world(shape.tailParts[i].id)!,
          dir: norm(sub(tailNodes[i], tailNodes[i - 1]), [0, 0, -1]),
        });
      }
    } else {
      const segment = (2.5 * shape.size) / segments;
      for (let i = 0; i <= segments; i++) tailNodes.push([0, 0, -segment * i]);
      for (let i = 0; i < segments; i++) tailLengths.push(segment);
    }
  }

  // samples of every keyed object
  const flyerSamples = transformSamples();
  const stringSamples = { ...transformSamples(), scale: [] as Vec3[] };
  const tailWorlds: Mat4[][] = Array.from({ length: segments }, () => []);
  let flyerRotation: Vec3 = [...flyer.rotation_euler];
  let stringX: Vec3 = [1, 0, 0];
  let stringRotation: Vec3 = [0, 0, 0];
  const elevations: number[] = [];
  let maxStretch = 0;
  // the landing (after: 'land'): from the flight's last pose to the kite lying on the ground
  let land: ((tf: number) => Mat4) | null = null;

  // the line pays out at the launch rate while the flyer pulls it taut (a slack line lets nothing
  // out, so a kite climbs on a taut line instead of drifting downwind on a loose one)
  let line = launchFrames > 0 ? lineStart : L;
  const payout = launchFrames > 0 ? ((L - lineStart) * fps) / launchFrames : Infinity;
  // the flyer's tug while the line pays out (kites only): air past the kite along the wind
  const tugFull =
    shape.kind === 'kite' && launchFrames > 0
      ? Math.max(0, payout / CLIMB_PER_AIRSPEED - o.wind_mps) * Math.min(1, o.wind_mps / TUG_FULL_WIND_MPS)
      : 0;
  let tug = 0;
  for (let i = 0; i < total; i++) {
    const f = o.frame_start + i;
    if (i > 0) {
      for (let st = 1; st <= STEPS; st++) {
        const tf = i - 1 + st / STEPS;
        const t = tf / fps;
        if (land) {
          // landing: the flyer follows its path down, the tail trails in the wind
          if (segments) {
            tailNodes[0] = transform(land(tf), tailLocalAnchor);
            stepTail(tailNodes, tailPrev, tailLengths, wind(t), dt, downwind);
          }
          continue;
        }
        const a = anchorAt(tf);
        if (line < L && len(sub(p, a)) >= line - 0.01) line = Math.min(L, line + payout * dt);
        tug = line < L ? tugFull : tug * Math.max(0, 1 - dt / TUG_FADE_SECONDS);
        const w = tug > 0 ? add(wind(t), mul(downwind, tug)) : wind(t);
        const u = sub(w, v);
        const speed = len(u);
        let force: Vec3 = [0, 0, -9.81 * shape.mass];
        if (shape.kind === 'kite') {
          force = add(force, mul(u, k * KITE_CD * speed));
          if (speed > 1e-6) {
            const uh = mul(u, 1 / speed);
            const n = sub([0, 0, 1], mul(uh, uh[2]));
            if (len(n) > 1e-6) force = add(force, mul(norm(n), k * KITE_CL * speed * speed));
          }
        } else {
          force = add(force, [0, 0, shape.lift]);
          force = add(force, mul(u, k * BALLOON_CD * speed));
        }
        v = add(v, mul(force, dt / shape.mass));
        let next = add(p, mul(v, dt));
        // the string never stretches; the ground stops the flyer's lowest point (as posed at the
        // step's start) at z = 0
        const clearance = clearanceAt(p, a, t);
        for (let it = 0; it < 2; it++) {
          const r = sub(next, a);
          const d = len(r);
          if (d > line) {
            const rh = mul(r, 1 / d);
            next = add(a, mul(rh, line));
            const out = dot(v, rh);
            if (out > 0) v = sub(v, mul(rh, out));
          }
          if (next[2] < clearance) {
            next[2] = clearance;
            if (v[2] < 0) v[2] = 0;
            const grip = Math.exp(-6 * dt);
            v = [v[0] * grip, v[1] * grip, v[2]];
          }
        }
        // the string wins over the ground where both cannot hold (an anchor lower than the flyer's size)
        const r = sub(next, a);
        const d = len(r);
        if (d > line) next = add(a, mul(r, line / d));
        p = next;
        if (segments) {
          // the tail's top moves with the flyer within the frame; its points trail
          tailNodes[0] = transform(poseAt(p, a, t).world, tailLocalAnchor);
          stepTail(tailNodes, tailPrev, tailLengths, w, dt, downwind);
        }
      }
    }
    let world: Mat4;
    let x: Vec3;
    if (land) {
      world = land(i);
      x = norm([world[0], world[1], world[2]], [1, 0, 0]);
    } else {
      const a = anchors[i];
      if (shape.kind === 'kite')
        lateral = 0.85 * lateral + 0.15 * dot(v, norm(cross([0, 0, 1], sub(a, p)), [1, 0, 0]));
      ({ world, x } = poseAt(p, a, i / fps));
      // the pose keyed never reaches under the ground (lifted, unless the string cannot give)
      const low = lowest(world);
      if (low < 0) {
        p = [p[0], p[1], p[2] - low];
        const r = sub(p, a);
        if (len(r) > line) p = add(a, mul(r, line / len(r)));
        ({ world, x } = poseAt(p, a, i / fps));
      }
      const toAnchor = sub(a, p);
      maxStretch = Math.max(maxStretch, len(toAnchor) - L);
      if (i >= launchFrames && len(toAnchor) > 1e-6)
        elevations.push((Math.asin(-toAnchor[2] / len(toAnchor)) * 180) / Math.PI);
      // the string: from the anchor to the bridle
      const along = sub(p, a);
      const [sx, sy, sz] = alongAxes(along, stringX);
      stringX = sx;
      const sk = channelsFor(frame(sx, sy, sz, [1, 1, 1], a), null, [1, 1, 1], stringRotation);
      stringRotation = sk.rotation_euler;
      stringSamples.frames.push(f);
      stringSamples.location.push(sk.location);
      stringSamples.rotation.push(sk.rotation_euler);
      stringSamples.scale.push([1, 1, Math.max(1e-4, len(along))]);
      // the flight's last frame: the landing starts from its pose, and takes as long as its height asks
      if (i === frames - 1 && after === 'land') {
        const path = landingPath(world, a, i, fps, {
          downwind,
          placed,
          lowest: (m) => Math.min(...shape.sail.map((c) => transform(m, c)[2])),
          bridle: p,
          seed,
        });
        land = path.at;
        landFrames = Math.min(c.landFrames, path.frames);
        total = frames + landFrames + settleFrames;
      }
    }
    const flyerKeys = channelsFor(world, flyerParents[i], flyer.scale, flyerRotation);
    flyerRotation = flyerKeys.rotation_euler;
    flyerSamples.frames.push(f);
    flyerSamples.location.push(flyerKeys.location);
    flyerSamples.rotation.push(flyerKeys.rotation_euler);
    if (segments) {
      const top = transform(world, tailLocalAnchor);
      if (i === 0) {
        // own parts hang from the flyer's first pose as they hang at rest; a new tail hangs straight
        // down to the ground and lies on it downwind
        const shift = sub(top, tailNodes[0]);
        const start = ownTail ? tailNodes.map((n) => add(n, shift)) : hangingTail(top, tailLengths, downwind);
        tailNodes.splice(0, tailNodes.length, ...start);
      }
      tailNodes[0] = top;
      settleTail(tailNodes, tailLengths, downwind);
      // at rest when the flight starts (a settled first pose, not one flung by its own corrections)
      if (i === 0) for (let n = 0; n < tailNodes.length; n++) tailPrev[n] = [...tailNodes[n]];
      // a landing kite's own parts turn with it as it comes down, to lie as they hang under it
      const lying = landFrames ? landingEase(Math.min(1, Math.max(0, (i - frames + 1) / landFrames))) : 0;
      for (let n = 0; n < segments; n++) {
        if (ownTail) {
          // part n + 1 sits on node n + 1, turned as the chain turned from its rest direction
          const dir = norm(sub(tailNodes[n + 1], tailNodes[n]), restParts[n].dir);
          const hung = turnedWorld(restParts[n].world, restParts[n].dir, dir, tailNodes[n + 1]);
          tailWorlds[n].push(
            lying > 0
              ? blendTurn(
                  hung,
                  turnedWithFlyer(restParts[n], world, flyerWorld0, dir, tailNodes[n + 1]),
                  lying,
                )
              : hung,
          );
        } else {
          const [tx, ty, tz] = hangingAxes(sub(tailNodes[n + 1], tailNodes[n]), x);
          tailWorlds[n].push(frame(tx, ty, tz, [1, 1, 1], tailNodes[n]));
        }
      }
    }
  }
  if (maxStretch > 1e-6)
    warnings.push(`the string stretched by ${maxStretch.toFixed(4)} m (anchor moving faster than the flyer)`);

  // ---- write. The flight keys its span (flightSpan). The flights it is flown over lose their keys
  // from its start on (up to a later flight it is not flown over); flights apart keep theirs.
  const span = flightSpan(o, total, after);
  const later = c.flights.filter((f) => !c.over.includes(f) && f.lo > span.lo);
  const nextLo = Math.min(Infinity, ...later.map((f) => f.lo));
  const clear: [number, number] = [
    span.lo,
    Math.min(Math.max(span.hi, ...c.over.map((f) => f.hi)), nextLo - 1),
  ];
  // the scene just before the flight, as it was before the flight keyed anything
  const before = sampler.at(o.frame_start - 1);
  const hiddenFrom = after === 'hide' ? o.frame_end + 1 : null;
  /**
   * The objects the flight keys and their channels it owns (a later flight's keys before it hold what
   * they are left at): the flyer's scale is not the flight's (its hiding is keyed apart).
   */
  const TRANSFORM = ['location', 'rotation_euler'] as const;
  const ALL = ['location', 'rotation_euler', 'scale'] as const;
  const keyed: { id: string; paths: readonly ChannelPath[] }[] = [{ id: flyer.id, paths: TRANSFORM }];

  // the flyer does what it did up to the flight (its own animation, or what an earlier flight left)
  holdAt(doc, flyer.id, o.frame_start - 1, before, clear);
  for (const con of doc.getObject(flyer.id)!.constraints)
    if (!con.mute && silenceConstraintFrom(doc, flyer.id, con.name, o.frame_start))
      warnings.push(`'${flyer.name}': constraint '${con.name}' no longer acts from frame ${o.frame_start}`);
  // every frame keyed (no clean-up: dropping a nearly equal key could let the string stretch)
  let keys = keyTransforms(doc, flyer.id, flyerSamples);
  if (hiddenFrom !== null) {
    // the flyer, its parts and its own tail parts with it, hidden from there (until a later flight)
    const shown = sceneSampler(doc).at(o.frame_end).byId.get(flyer.id)?.scale ?? flyer.scale;
    keys += hideFrom(doc, flyer.id, hiddenFrom, shown);
  }

  const previous = previousParts(doc, flyer.id);
  let stringId: string | null = null;
  if (o.string !== false) {
    stringId = previous.string?.id ?? null;
    if (!stringId) {
      const mesh = doc.addMesh(`${flyer.name} String`, stringMesh());
      stringId = doc.addObject({
        type: 'MESH',
        name: `${flyer.name} String`,
        data: mesh,
        custom_props: { desk_role: 'string', [STRING_OF]: flyer.id, [STRING_FROM]: anchorObject.id },
      });
    } else {
      const props = { ...previous.string!.custom_props, [STRING_FROM]: anchorObject.id };
      doc.updateObject(stringId, { custom_props: props, parent: null, constraints: [] });
    }
    keyed.push({ id: stringId, paths: ALL });
    keys += keyTransforms(doc, stringId, stringSamples, { replace: clear });
    for (let k3 = 0; k3 < 3; k3++)
      keys += writeChannel(
        doc,
        stringId,
        'scale',
        k3,
        stringSamples.frames,
        stringSamples.scale.map((sc) => sc[k3]),
        { replace: clear },
      );
    // before the flight: what an earlier flight left, else shrunk to a point on every axis
    keys += keyBefore(doc, stringId, o.frame_start - 1, before, clear[0]);
    // hidden after the flight too, when the flyer is put away or comes down (let go)
    if (after !== 'hold') keys += hideFrom(doc, stringId, o.frame_end + 1, stringSamples.scale[frames - 1]);
  } else if (previous.string) {
    // an earlier flight's string: not on this one
    keyed.push({ id: previous.string.id, paths: ALL });
    keys += hideThrough(doc, previous.string.id, o.frame_start, before, clear);
  }

  const tailObjects: string[] = [];
  if (segments && ownTail) {
    // the model's own tail parts, keyed relative to their parents (which may be keyed tail parts too)
    const parts = shape.tailParts.slice(1);
    const worlds = new Map<string, Mat4[]>(parts.map((part, n) => [part.id, tailWorlds[n]]));
    for (const [n, part] of parts.entries()) {
      const s = transformSamples();
      let rot: Vec3 = [...part.rotation_euler];
      for (let i = 0; i < total; i++) {
        const parent = part.parent
          ? keyedParentWorld(
              part.parent,
              i,
              worlds,
              flyer.id,
              flyerSamples,
              flyerParents,
              flyer.scale,
              sampler,
              o.frame_start,
            )
          : null;
        const t = channelsFor(tailWorlds[n][i], parent, part.scale, rot);
        rot = t.rotation_euler;
        s.frames.push(o.frame_start + i);
        s.location.push(t.location);
        s.rotation.push(t.rotation_euler);
      }
      holdAt(doc, part.id, o.frame_start - 1, before, clear);
      keys += keyTransforms(doc, part.id, s);
      tailObjects.push(part.id);
      keyed.push({ id: part.id, paths: TRANSFORM });
    }
  } else if (segments) {
    const segment = tailLengths[0];
    for (let n = 0; n < segments; n++) {
      let id = previous.tail[n]?.id;
      if (!id) {
        const mesh = doc.addMesh(
          `${flyer.name} Tail`,
          ribbonMesh(segment * 0.9, Math.max(0.02, 0.06 * shape.size)),
        );
        id = doc.addObject({
          type: 'MESH',
          name: `${flyer.name} Tail ${n + 1}`,
          data: mesh,
          custom_props: { desk_role: 'prop', [TAIL_OF]: flyer.id },
        });
      }
      const s = transformSamples();
      let rot: Vec3 = [0, 0, 0];
      for (let i = 0; i < total; i++) {
        const t = channelsFor(tailWorlds[n][i], null, [1, 1, 1], rot);
        rot = t.rotation_euler;
        s.frames.push(o.frame_start + i);
        s.location.push(t.location);
        s.rotation.push(t.rotation_euler);
      }
      keys += keyTransforms(doc, id, s, { replace: clear });
      // shown from the flight's first frame (before it like the string), hidden after it when the
      // flyer is put away
      const shownFrames = [o.frame_start];
      const shownScale = [1];
      if (hiddenFrom !== null) {
        shownFrames.push(hiddenFrom - 1, hiddenFrom);
        shownScale.push(1, hiddenScale(1));
      }
      for (let k3 = 0; k3 < 3; k3++)
        keys += writeChannel(doc, id, 'scale', k3, shownFrames, shownScale, {
          interpolation: 'CONSTANT',
          replace: clear,
        });
      keys += keyBefore(doc, id, o.frame_start - 1, before, clear[0]);
      tailObjects.push(id);
      keyed.push({ id, paths: ALL });
    }
  }
  // an earlier flight's tail segments this one does not key (it flies without that tail): hidden
  for (const extra of previous.tail.slice(segments && !ownTail ? segments : 0)) {
    keyed.push({ id: extra.id, paths: ALL });
    keys += hideThrough(doc, extra.id, o.frame_start, before, clear);
  }

  // a later flight (flown before this one) starts from what this one leaves: its keys before it hold
  // that, and a flyer this one hid is shown again for it
  const next = later.find((f) => f.lo === nextLo);
  const nextShown = !!next && hiddenFrom !== null && showFrom(doc, flyer, next.lo + 1);
  if (next) for (const { id, paths } of keyed) holdUntil(doc, id, paths, next.lo);
  // the flights the flyer has flown now; one flown over keeps its keys before this one, and a step
  // hiding the flyer just before it
  const flown = c.flights.flatMap((f): Flight[] => {
    if (!c.over.includes(f)) return [f === next && nextShown ? { ...f, showed: true } : f];
    if (f.lo >= span.lo) return [];
    return [f.hid && f.hi === span.lo ? f : { ...f, hi: span.lo - 1, hid: false }];
  });
  flown.push({
    ...span,
    hid: hiddenFrom !== null,
    showed: c.showed,
    anchor: anchorObject.id,
    ...(o.anchor_bone ? { bone: o.anchor_bone } : {}),
  });
  const props: ObjectData['custom_props'] = {
    ...doc.getObject(flyer.id)!.custom_props,
    [FLIGHTS]: flightsText(flown.sort((a, b) => a.lo - b.lo)),
  };
  delete props[LEGACY_HIDDEN_FROM];
  doc.updateObject(flyer.id, { custom_props: props });

  const mean = elevations.length ? elevations.reduce((s, e) => s + e, 0) / elevations.length : 0;
  return {
    flyer: flyer.id,
    string: stringId,
    tail: tailObjects[0] ?? null,
    tail_objects: tailObjects,
    frame_end: o.frame_end,
    kind: shape.kind,
    seed,
    mean_elevation_deg: Math.round(mean * 100) / 100,
    after,
    hidden_from: hiddenFrom,
    landed_frame: landFrames ? o.frame_end + landFrames : null,
    keyframes: keys,
    warnings,
  };
}

/** How far a landing has turned and moved over the ground at its share `s` (0–1) of the time: smooth at both ends. */
const landingEase = (s: number): number => s * s * (3 - 2 * s);

/**
 * World matrix of an own tail part (`rest`: its world and chain direction when the flight starts) as
 * it would hang if it had turned with the flyer since then (`flyer`, `flyer0`: the flyer's world
 * matrices now and then), turned on along its chain to `dir`, at `at`: a bow lying as it hangs flat
 * under the kite, not on its edge.
 */
function turnedWithFlyer(
  rest: { world: Mat4; dir: Vec3 },
  flyer: Readonly<Mat4>,
  flyer0: Readonly<Mat4>,
  dir: Vec3,
  at: Vec3,
): Mat4 {
  const [x, y, z] = axesOf(flyer);
  const [x0, y0, z0] = axesOf(flyer0);
  // the flyer's turn since the flight started (its rotation now times its rotation then, inverted)
  const r = (v: Vec3): Vec3 => add(add(mul(x, dot(x0, v)), mul(y, dot(y0, v))), mul(z, dot(z0, v)));
  const m = [...rest.world] as Mat4;
  for (let c = 0; c < 3; c++) {
    const v = r([rest.world[c * 4], rest.world[c * 4 + 1], rest.world[c * 4 + 2]]);
    m[c * 4] = v[0];
    m[c * 4 + 1] = v[1];
    m[c * 4 + 2] = v[2];
  }
  return turnedWorld(m, norm(r(rest.dir), dir), dir, at);
}

/** `a`'s rotation turned toward `b`'s by `w` (0–1; quaternion slerp), with `a`'s scale and origin. */
function blendTurn(a: Readonly<Mat4>, b: Readonly<Mat4>, w: number): Mat4 {
  if (w <= 0 || mirrors(a) || mirrors(b)) return [...a] as Mat4;
  const [x, y, z] = axesOfQuat(slerpQ(quatOfAxes(axesOf(a)), quatOfAxes(axesOf(b)), Math.min(1, w)));
  return frame(x, y, z, columnScale(a), originOf(a));
}

/**
 * The path of a kite landing after its flight (after: 'land'): from its pose at the flight's last
 * frame (`world`, its bridle at `bridle`, the anchor at `anchor`, flight frame `i0`) it nose-dives
 * toward the anchor, turning from its flying attitude (front to the anchor, nose up) to lie flat face
 * down with its nose to the anchor, so its tail trails downwind; it rests LAND_REACH of its distance
 * from the anchor away, the lowest corner of its sail (`lowest`: its bridle lines fold under it) just
 * above the ground. It takes tetherLandSeconds of its drop (`frames` of them at `fps`), dropping slowly
 * at first, fastest halfway and slowing again near the ground (it touches down softly, its speed at
 * most about half a dropped stone's on landing from that height). A small seeded wobble about its nose
 * fades as it lands. `at` is its world matrix at a (fractional) flight frame.
 */
function landingPath(
  world: Readonly<Mat4>,
  anchor: Readonly<Vec3>,
  i0: number,
  fps: number,
  o: {
    downwind: Vec3;
    placed: (axes: [Vec3, Vec3, Vec3], at: Vec3) => Mat4;
    lowest: (world: Readonly<Mat4>) => number;
    bridle: Vec3;
    seed: number;
  },
): { at: (tf: number) => Mat4; frames: number } {
  const start = o.bridle;
  // lying flat, face (−Y) down, nose (+Z) to the anchor: its bottom and tail downwind
  const toAnchor: Vec3 = [anchor[0] - start[0], anchor[1] - start[1], 0];
  const nose = len(toAnchor) > 1e-3 ? norm(toAnchor) : mul(o.downwind, -1);
  const up: Vec3 = [0, 0, 1];
  const lying: [Vec3, Vec3, Vec3] = [norm(cross(up, nose)), up, nose];
  const ground: Vec3 = [
    anchor[0] + (start[0] - anchor[0]) * LAND_REACH,
    anchor[1] + (start[1] - anchor[1]) * LAND_REACH,
    0,
  ];
  const rest = o.placed(lying, ground);
  ground[2] = LANDED_CLEARANCE - o.lowest(rest);
  const q0 = quatOfAxes(axesOf(world));
  const q1 = quatOfAxes(lying);
  const wobble = (o.seed & 1 ? 1 : -1) * 0.3;
  const frames = Math.max(1, Math.round(tetherLandSeconds(start[2] - ground[2]) * fps));
  const at = (tf: number): Mat4 => {
    const s = Math.min(1, Math.max(0, (tf - i0) / frames));
    const ease = landingEase(s);
    let axes = axesOfQuat(slerpQ(q0, q1, ease));
    // a fading wobble about the nose while it comes down
    const roll = wobble * Math.sin(2.5 * Math.PI * s) * (1 - s);
    if (roll) {
      const [x, y, z] = axes;
      const cr = Math.cos(roll);
      const sr = Math.sin(roll);
      axes = [add(mul(x, cr), mul(y, sr)), add(mul(y, cr), mul(x, -sr)), z];
    }
    // down: slow at first, fastest halfway, slowing to touch the ground softly
    const p: Vec3 = [
      start[0] + (ground[0] - start[0]) * ease,
      start[1] + (ground[1] - start[1]) * ease,
      start[2] + (ground[2] - start[2]) * ease,
    ];
    let m = o.placed(axes, p);
    // never under the ground on the way down
    const low = o.lowest(m);
    if (low < LANDED_CLEARANCE && s < 1) m = o.placed(axes, [p[0], p[1], p[2] + LANDED_CLEARANCE - low]);
    return m;
  };
  return { at, frames };
}

/** Height above z = 0 at which a tail's points lie on the ground. */
const TAIL_GROUND = 0.01;

/** Points of a tail hanging from `top`: straight down to the ground, then along it toward `along` (a horizontal unit vector). */
function hangingTail(top: Vec3, lengths: readonly number[], along: Vec3): Vec3[] {
  const nodes: Vec3[] = [[...top]];
  for (const l of lengths) {
    const prev = nodes[nodes.length - 1];
    const drop = Math.min(l, Math.max(0, prev[2] - TAIL_GROUND));
    const flat = Math.sqrt(Math.max(0, l * l - drop * drop));
    nodes.push([prev[0] + along[0] * flat, prev[1] + along[1] * flat, prev[2] - drop]);
  }
  return nodes;
}

/** Advances a tail one step: Verlet points with damping, gravity and the wind's drag, then its lengths. */
function stepTail(
  nodes: Vec3[],
  prev: Vec3[],
  lengths: readonly number[],
  wind: Vec3,
  dt: number,
  along: Vec3,
): void {
  const damping = 0.03;
  const drag = 3;
  for (let n = 1; n < nodes.length; n++) {
    const cur = nodes[n];
    const vel = mul(sub(cur, prev[n]), 1 / dt);
    const acc: Vec3 = add([0, 0, -9.81], mul(sub(wind, vel), drag));
    const next = add(add(cur, mul(sub(cur, prev[n]), 1 - damping)), mul(acc, dt * dt));
    prev[n] = cur;
    nodes[n] = next;
  }
  settleTail(nodes, lengths, along);
}

/**
 * The tail's segment lengths (node 0 fixed to the flyer) and the ground: relaxed a few times, then
 * exact from the top down, a point that would go under the ground laid on it (in the direction the
 * segment pointed, else `along`).
 */
function settleTail(nodes: Vec3[], lengths: readonly number[], along: Vec3): void {
  for (let it = 0; it < 4; it++) {
    for (let n = 1; n < nodes.length; n++) {
      const r = sub(nodes[n], nodes[n - 1]);
      const d = len(r) || 1e-9;
      const want = lengths[n - 1];
      if (n === 1) nodes[n] = add(nodes[n - 1], mul(r, want / d));
      else {
        const half = mul(r, (d - want) / d / 2);
        nodes[n - 1] = add(nodes[n - 1], half);
        nodes[n] = sub(nodes[n], half);
      }
    }
    for (let n = 1; n < nodes.length; n++) if (nodes[n][2] < TAIL_GROUND) nodes[n][2] = TAIL_GROUND;
  }
  for (let n = 1; n < nodes.length; n++) {
    const prev = nodes[n - 1];
    const r = sub(nodes[n], prev);
    const d = len(r);
    const want = lengths[n - 1];
    let next: Vec3 = d > 1e-9 ? add(prev, mul(r, want / d)) : [prev[0], prev[1], prev[2] - want];
    if (next[2] < TAIL_GROUND) {
      const drop = Math.max(0, prev[2] - TAIL_GROUND);
      const flat = Math.sqrt(Math.max(0, want * want - drop * drop));
      const h = Math.hypot(r[0], r[1]);
      const dir: Vec3 = h > 1e-9 ? [r[0] / h, r[1] / h, 0] : along;
      next = [prev[0] + dir[0] * flat, prev[1] + dir[1] * flat, prev[2] - drop];
    }
    nodes[n] = next;
  }
}

/**
 * World matrix at flight frame `i` of a keyed tail part's parent: a keyed tail part's world, the
 * flyer's keyed world, or (above them) the parent's world from the scene with its keyed children
 * composed below.
 */
function keyedParentWorld(
  parent: string,
  i: number,
  worlds: ReadonlyMap<string, Mat4[]>,
  flyer: string,
  flyerSamples: TransformSamples,
  flyerParents: readonly (Mat4 | null)[],
  flyerScale: Vec3,
  sampler: ReturnType<typeof sceneSampler>,
  frameStart: number,
): Mat4 | null {
  const keyed = worlds.get(parent);
  if (keyed) return keyed[i];
  if (parent === flyer) {
    const local = compose4(flyerSamples.location[i], flyerSamples.rotation[i], flyerScale);
    const above = flyerParents[i];
    return above ? multiply4(above, local) : local;
  }
  return sampler.at(frameStart + i).world(parent);
}

/** The F-curve of object `id`'s channel `path`[`index`], if keyed. */
const channelCurve = (doc: SceneDoc, id: string, path: string, index: number): FCurve | null =>
  doc.getFCurve(fcurveKey({ target_type: 'object', target_id: id, path, index })) ?? null;

/**
 * Keeps object `id`'s transform up to `frame` as it was before the flight (`fs`: the scene there): a
 * CONSTANT key at `frame` on each location and rotation channel with the value it held there. The
 * channel's keys in `clear` (from `frame` on: the frames the flight takes over) go.
 */
function holdAt(doc: SceneDoc, id: string, frame: number, fs: FrameState, clear: [number, number]): void {
  const was = fs.byId.get(id);
  if (!was) return;
  for (const path of ['location', 'rotation_euler'] as const)
    for (let i = 0; i < 3; i++)
      writeChannel(doc, id, path, i, [frame], [was[path][i]], { interpolation: 'CONSTANT', replace: clear });
}

/**
 * The key before a flight (CONSTANT, at `frame`) on each channel of object `id`, a string or a tail
 * segment the flight keys: a channel with keys before `lo` (an earlier flight's) holds the value it had
 * at `frame` before the flight (`fs`); one without has none before the flight, so its scale is shrunk
 * to a point (TETHER_HIDDEN_SCALE) and its other channels get no key. Returns the keys written.
 */
function keyBefore(doc: SceneDoc, id: string, frame: number, fs: FrameState, lo: number): number {
  const was = fs.byId.get(id);
  let keys = 0;
  for (const path of ['location', 'rotation_euler', 'scale'] as const)
    for (let i = 0; i < 3; i++) {
      const earlier =
        !!was && !!channelCurve(doc, id, path, i)?.keyframes.some((k) => k.frame < lo - KEY_EPS);
      if (!earlier && path !== 'scale') continue;
      const value = was && earlier ? was[path][i] : TETHER_HIDDEN_SCALE;
      keys += writeChannel(doc, id, path, i, [frame], [value], { interpolation: 'CONSTANT' });
    }
  return keys;
}

/**
 * Hides object `id` (an earlier flight's string or tail segment a flight does not key) from `frame`
 * through the frames `clear` gives the flight, where it was just before it (`fs`); before it, it keeps
 * what was there (keyBefore). Returns the keys written.
 */
function hideThrough(
  doc: SceneDoc,
  id: string,
  frame: number,
  fs: FrameState,
  clear: [number, number],
): number {
  const was = fs.byId.get(id);
  let keys = 0;
  if (was)
    for (const path of ['location', 'rotation_euler', 'scale'] as const)
      for (let i = 0; i < 3; i++) {
        const value = path === 'scale' ? hiddenScale(was.scale[i]) : was[path][i];
        keys += writeChannel(doc, id, path, i, [frame], [value], {
          interpolation: 'CONSTANT',
          replace: clear,
        });
      }
  return keys + keyBefore(doc, id, frame - 1, fs, clear[0]);
}

/** A transform channel a flight keys. */
type ChannelPath = 'location' | 'rotation_euler' | 'scale';

/**
 * Keys object `id`'s channels `paths` at `frame` (the key before a later flight, CONSTANT) to the
 * values the keys before it leave there: what a flight leaves holds until the later one starts.
 * Channels without keys before `frame` are left as they are.
 */
function holdUntil(doc: SceneDoc, id: string, paths: readonly ChannelPath[], frame: number): void {
  for (const path of paths)
    for (let i = 0; i < 3; i++) {
      const fc = channelCurve(doc, id, path, i);
      const earlier = fc ? fc.keyframes.filter((k) => k.frame < frame - KEY_EPS) : [];
      if (!fc || !earlier.length) continue;
      const v = evaluateFCurve({ ...fc, keyframes: earlier }, frame);
      const at = fc.keyframes.find((k) => Math.abs(k.frame - frame) < KEY_EPS);
      if (v === undefined || (at?.value === v && at.interpolation === 'CONSTANT')) continue;
      writeChannel(doc, id, path, i, [frame], [v], { interpolation: 'CONSTANT' });
    }
}

/** Keys the flyer shown from `frame` where its scale keys hide it there (see shownAt). True when it did. */
function showFrom(doc: SceneDoc, flyer: ObjectData, frame: number): boolean {
  let showed = false;
  for (let i = 0; i < 3; i++) {
    const fc = channelCurve(doc, flyer.id, 'scale', i);
    const keyframes = fc ? shownAt(fc, fc.keyframes, frame, flyer.scale[i]) : null;
    if (!fc || !keyframes) continue;
    doc.setFCurve({ ...fc, keyframes });
    showed = true;
  }
  return showed;
}
