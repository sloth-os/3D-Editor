import type { Mat4, Vec3 } from '../../math/types';
import { compose4, invert4, multiply4 } from '../../math/mat4';
import type { SceneDoc } from '../../doc/scene-doc';
import type { ObjectData } from '../../doc/types';
import { createCube, createCylinder } from '../../mesh/primitives';
import type { MeshData } from '../../mesh/types';
import type { FrameState } from '../../eval/frame-state';
import { OperatorError } from '../../operators/context';
import { getCatalogEntry } from '../../store/catalog';
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
 * tugging a kite up when the wind alone climbs slower). The ground stops it: no corner of its bounds
 * goes below z = 0. The wind is steady with seeded gusts and lulls, so the same seed flies the same
 * flight. A kite settles where lift and drag balance its weight and the string's pull, 35–60° above
 * the horizon in a steady wind, and dips in the lulls; it faces the anchor (its front, −Y, along the
 * string), nose up. A tail of 4–6 damped segments trails from its bottom (the model's own 'tail'
 * parts when it has them) and a thin string object (desk_role 'string', a cylinder along its local +Z
 * from the anchor to the bridle) is keyed to join them.
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
  /** Corners of the flyer's bounds (with its parts), in its object space: what the ground stops. */
  corners: Vec3[];
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

/** Object-space bounds of a flyer and its mesh parts (in the flyer's object space). */
function flyerBounds(doc: SceneDoc, fs: FrameState, flyer: ObjectData): { min: Vec3; max: Vec3 } | null {
  const inv = invert4(fs.world(flyer.id)!);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const o of [flyer, ...descendants(doc, flyer.id)]) {
    const b = o.type === 'MESH' ? localBounds(doc, o) : null;
    const w = fs.world(o.id);
    if (!b || !w) continue;
    const m = multiply4(inv, w);
    for (const cx of [b.min[0], b.max[0]])
      for (const cy of [b.min[1], b.max[1]])
        for (const cz of [b.min[2], b.max[2]]) {
          const p = transform(m, [cx, cy, cz]);
          for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], p[k]);
            max[k] = Math.max(max[k], p[k]);
          }
          any = true;
        }
  }
  return any ? { min, max } : null;
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
  const kind = /balloon/i.test(identityWords(doc, flyer)) ? 'balloon' : 'kite';
  const world = fs.world(flyer.id)!;
  const inv = invert4(world);
  const parts = descendants(doc, flyer.id);
  const bridleObject = parts.find((p) => /^(bridle|string_point)$/i.test(baseName(p.name)));
  const bridleWorld = bridleObject ? fs.world(bridleObject.id) : null;
  const bridle: Vec3 = bridleWorld ? transform(inv, originOf(bridleWorld)) : [0, 0, 0];
  const b = flyerBounds(doc, fs, flyer) ?? { min: [-0.4, -0.05, -0.5], max: [0.4, 0.05, 0.5] };
  const scale = columnScale(world);
  const ext = [0, 1, 2].map((k) => (b.max[k] - b.min[k]) * scale[k]).sort((x, y) => y - x);
  const corners: Vec3[] = [];
  for (const cx of [b.min[0], b.max[0]])
    for (const cy of [b.min[1], b.max[1]]) for (const cz of [b.min[2], b.max[2]]) corners.push([cx, cy, cz]);
  const size = Math.max(0.1, ext[0]);
  const tailParts = parts.filter((p) => /^tail/i.test(baseName(p.name))).sort(naturally);
  const tailAnchor: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.min[2]];
  if (kind === 'kite') {
    const area = Math.max(0.05, (ext[0] * ext[1]) / 2);
    return {
      kind,
      bridle,
      corners,
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
    area,
    mass,
    lift: BALLOON_LIFT_PER_M3 * volume,
    size,
    tailAnchor,
    tailParts,
  };
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

/**
 * Flies `o.flyer` on a string from `o.anchor` (see the module comment); keys the flyer, the string and
 * the tail on every frame of frame_start … frame_end (before that the flyer keeps its own animation:
 * its constraints, a hand holding it, stop acting at frame_start).
 */
export function tetherFly(doc: SceneDoc, o: TetherOptions): TetherResult {
  const warnings: string[] = [];
  const flyer = doc.getObject(o.flyer);
  const anchorObject = doc.getObject(o.anchor);
  if (!flyer) throw new OperatorError(`Object '${o.flyer}' not found`, 'NOT_FOUND');
  if (!anchorObject) throw new OperatorError(`Object '${o.anchor}' not found`, 'NOT_FOUND');
  if (o.flyer === o.anchor) throw new OperatorError('The flyer cannot be its own anchor', 'INVALID_PARAMS');
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
  const frames = o.frame_end - o.frame_start + 1;
  if (frames > TETHER_MAX_FRAMES)
    throw new OperatorError(
      `A flight of ${frames} frames is longer than ${TETHER_MAX_FRAMES}: fly a shorter range (frame_start, frame_end)`,
      'INVALID_PARAMS',
    );
  const fps = Math.max(1, doc.getScene().fps || 24);
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
  const keyed = 1 + (o.string === false ? 0 : 1) + segments;
  if (frames * keyed > TETHER_MAX_OBJECT_FRAMES)
    throw new OperatorError(
      `Keying ${keyed} objects over ${frames} frames is more than ${TETHER_MAX_OBJECT_FRAMES} object frames: fly a ` +
        'shorter range, or without the tail (tail: false)',
      'INVALID_PARAMS',
    );

  // the anchor on every frame (and one before, for the string's hidden state)
  const anchors: Vec3[] = [];
  const flyerParents: (Mat4 | null)[] = [];
  for (let f = o.frame_start; f <= o.frame_end; f++) {
    const fs = f === o.frame_start ? fs0 : sampler.at(f);
    const a = anchorPoint(fs, anchorObject.id, o.anchor_bone);
    if (!a)
      throw new OperatorError(
        o.anchor_bone
          ? `Bone '${o.anchor_bone}' not found in '${anchorObject.name}'`
          : `'${anchorObject.name}' has no transform at frame ${f}`,
        o.anchor_bone ? 'NOT_FOUND' : 'FAILED',
      );
    anchors.push(a);
    flyerParents.push(parentMatrix(fs, flyer));
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
    const [x, y, z] = axes;
    const rotated = add(add(mul(x, bridleOffset[0]), mul(y, bridleOffset[1])), mul(z, bridleOffset[2]));
    return { world: frame(x, y, z, flyerScale, sub(at, rotated)), x };
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
  for (let i = 0; i < frames; i++) {
    const f = o.frame_start + i;
    if (i > 0) {
      for (let st = 1; st <= STEPS; st++) {
        const tf = i - 1 + st / STEPS;
        const t = tf / fps;
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
    const a = anchors[i];
    if (shape.kind === 'kite')
      lateral = 0.85 * lateral + 0.15 * dot(v, norm(cross([0, 0, 1], sub(a, p)), [1, 0, 0]));
    let { world, x } = poseAt(p, a, i / fps);
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
    const flyerKeys = channelsFor(world, flyerParents[i], flyer.scale, flyerRotation);
    flyerRotation = flyerKeys.rotation_euler;
    flyerSamples.frames.push(f);
    flyerSamples.location.push(flyerKeys.location);
    flyerSamples.rotation.push(flyerKeys.rotation_euler);
    if (i >= launchFrames && len(toAnchor) > 1e-6)
      elevations.push((Math.asin(-toAnchor[2] / len(toAnchor)) * 180) / Math.PI);
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
      for (let n = 0; n < segments; n++) {
        if (ownTail) {
          // part n + 1 sits on node n + 1, turned as the chain turned from its rest direction
          const dir = norm(sub(tailNodes[n + 1], tailNodes[n]), restParts[n].dir);
          tailWorlds[n].push(turnedWorld(restParts[n].world, restParts[n].dir, dir, tailNodes[n + 1]));
        } else {
          const [tx, ty, tz] = hangingAxes(sub(tailNodes[n + 1], tailNodes[n]), x);
          tailWorlds[n].push(frame(tx, ty, tz, [1, 1, 1], tailNodes[n]));
        }
      }
    }
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
  }
  if (maxStretch > 1e-6)
    warnings.push(`the string stretched by ${maxStretch.toFixed(4)} m (anchor moving faster than the flyer)`);

  // ---- write: the flyer keeps its own transform before the flight
  holdBefore(doc, flyer.id, o.frame_start, sampler.at(o.frame_start - 1));
  for (const c of doc.getObject(flyer.id)!.constraints)
    if (!c.mute && silenceConstraintFrom(doc, flyer.id, c.name, o.frame_start))
      warnings.push(`'${flyer.name}': constraint '${c.name}' no longer acts from frame ${o.frame_start}`);
  // every frame keyed (no clean-up: dropping a nearly equal key could let the string stretch)
  let keys = keyTransforms(doc, flyer.id, flyerSamples);

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
    // hidden (a tenth of a millimetre long) before the flight
    const before = o.frame_start - 1;
    keys += writeChannel(doc, stringId, 'scale', 2, [before], [1e-4], {
      interpolation: 'CONSTANT',
      replace: [-Infinity, before],
    });
    for (let k3 = 0; k3 < 2; k3++)
      keys += writeChannel(doc, stringId, 'scale', k3, [before], [1], {
        interpolation: 'CONSTANT',
        replace: [-Infinity, before],
      });
    keys += keyTransforms(doc, stringId, stringSamples, { replace: [o.frame_start, Infinity] });
    for (let k3 = 0; k3 < 3; k3++)
      keys += writeChannel(
        doc,
        stringId,
        'scale',
        k3,
        stringSamples.frames,
        stringSamples.scale.map((sc) => sc[k3]),
        { replace: [o.frame_start, Infinity] },
      );
  }

  const tailObjects: string[] = [];
  if (segments) {
    if (ownTail) {
      // the model's own tail parts, keyed relative to their parents (which may be keyed tail parts too)
      const parts = shape.tailParts.slice(1);
      const worlds = new Map<string, Mat4[]>(parts.map((part, n) => [part.id, tailWorlds[n]]));
      for (const [n, part] of parts.entries()) {
        const s = transformSamples();
        let rot: Vec3 = [...part.rotation_euler];
        for (let i = 0; i < frames; i++) {
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
        holdBefore(doc, part.id, o.frame_start, sampler.at(o.frame_start - 1));
        keys += keyTransforms(doc, part.id, s);
        tailObjects.push(part.id);
      }
    } else {
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
        for (let i = 0; i < frames; i++) {
          const t = channelsFor(tailWorlds[n][i], null, [1, 1, 1], rot);
          rot = t.rotation_euler;
          s.frames.push(o.frame_start + i);
          s.location.push(t.location);
          s.rotation.push(t.rotation_euler);
        }
        keys += keyTransforms(doc, id, s, { replace: [-Infinity, Infinity] });
        // hidden before the flight (a tenth of a millimetre), like the string
        for (let k3 = 0; k3 < 3; k3++)
          keys += writeChannel(doc, id, 'scale', k3, [o.frame_start - 1, o.frame_start], [1e-4, 1], {
            interpolation: 'CONSTANT',
            replace: [-Infinity, Infinity],
          });
        tailObjects.push(id);
      }
      // segments of an earlier, longer tail are not needed any more
      for (const extra of previous.tail.slice(segments)) doc.removeObject(extra.id);
    }
  }
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
    keyframes: keys,
    warnings,
  };
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

/**
 * Keeps object `id`'s transform before `frame` as it was: a key one frame before, CONSTANT, with the
 * values its channels hold there, on each channel without a key before `frame`.
 */
function holdBefore(doc: SceneDoc, id: string, frame: number, fs: FrameState): void {
  const animated = fs.byId.get(id);
  if (!animated) return;
  for (const path of ['location', 'rotation_euler'] as const)
    for (let i = 0; i < 3; i++) {
      const fc = doc.getFCurve(`object:${id}:${path}:${i}`);
      if (fc?.keyframes.some((k) => k.frame < frame - 1e-3)) continue;
      writeChannel(doc, id, path, i, [frame - 1], [animated[path][i]], { interpolation: 'CONSTANT' });
    }
}
