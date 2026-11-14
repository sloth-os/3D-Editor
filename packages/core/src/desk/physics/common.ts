import type { Mat4, Vec3 } from '../../math/types';
import { invert4, multiply4 } from '../../math/mat4';
import { fcurveKey, type SceneDoc } from '../../doc/scene-doc';
import type { FCurve, Keyframe, ObjectData } from '../../doc/types';
import { createFCurve, evaluateFCurve } from '../../anim/fcurve';
import { FrameState } from '../../eval/frame-state';
import { worldMatrixToTransform } from '../../constraints/bake';
import type { RigidBodyHost } from '../../physics/rigid-body';
import { composeRigid, decomposeRigid } from '../../physics/vmath';

/*
 * Helpers the desk's motion presets share (MOTION): reading the scene at many frames without
 * reading the document again for each, keying channels in bulk, and taking over an object's
 * transform from a frame on (its constraints silenced there, its hold constraints removed).
 */

/** Custom property the rigid body bakes set on the objects they bake ('frames A-B step S'; operators/physics.ts). */
export const RIGID_BODY_BAKED_PROP = 'rigid_body_baked';

/** Tolerance of keyframe frames: keys within it of a frame are that frame's (anim/fcurve.ts insertKeyframe). */
const FRAME_EPS = 1e-3;

/**
 * Frame states of `doc` that share one reading of the document (FrameStateOptions.base), so sampling
 * many frames costs what evaluating them costs, not a copy of every object, F-curve and driver per
 * frame. The document must not change while they are used; make a new one after changing it.
 */
export interface SceneSampler extends RigidBodyHost {
  /** The scene at `frame` (with the simulated matrices of the rigid body world when given). */
  at(frame: number, simulated?: ReadonlyMap<string, Mat4> | null): FrameState;
}

export function sceneSampler(doc: SceneDoc): SceneSampler {
  let base: FrameState | null = null;
  const at = (frame: number, simulated: ReadonlyMap<string, Mat4> | null = null): FrameState => {
    const fs = base ? new FrameState(doc, frame, simulated, { base }) : new FrameState(doc, frame, simulated);
    base ??= fs;
    return fs;
  };
  return {
    at,
    transformsAt: (frame) => at(frame).allWorldMatrices(),
    meshOf: (id) => {
      const o = doc.getObject(id);
      return o?.type === 'MESH' && o.data ? doc.getMesh(o.data) : null;
    },
  };
}

/** Rounds to `digits` decimals (keys and reports of the presets). */
export const round = (v: number, digits = 6): number => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

/** Blender's bake clean-up: drops keys whose value equals both neighbours within 1e-4 (operators/physics.ts). */
export function dropRedundantKeys(keys: Keyframe[]): Keyframe[] {
  const out = [...keys];
  let i = 1;
  while (i < out.length - 1) {
    const v = out[i].value;
    if (Math.abs(v - out[i - 1].value) + Math.abs(v - out[i + 1].value) < 1e-4) out.splice(i, 1);
    else i++;
  }
  return out;
}

/** What {@link writeChannel} removed besides keys (reported by the operators). */
export interface KeyWriteStats {
  keys: number;
  drivers: number;
  modifiers: number;
}

/**
 * Keys `values` at `frames` on one object channel, replacing the keys the channel holds in
 * [first frame, last frame] (`replace` widens that range); the channel's driver and F-curve modifiers
 * are removed, so that the keys alone give the values. With `clean`, keys equal to both neighbours
 * are dropped (Blender's bake clean-up).
 */
export function writeChannel(
  doc: SceneDoc,
  target: string,
  path: string,
  index: number,
  frames: readonly number[],
  values: readonly number[],
  o: {
    interpolation?: Keyframe['interpolation'];
    clean?: boolean;
    replace?: [number, number];
    stats?: KeyWriteStats;
  } = {},
): number {
  if (!frames.length) return 0;
  const ref = { target_type: 'object' as const, target_id: target, path, index };
  const key = fcurveKey(ref);
  const fc = doc.getFCurve(key) ?? createFCurve(ref);
  const lo = Math.min(frames[0], o.replace?.[0] ?? Infinity) - FRAME_EPS;
  const hi = Math.max(frames[frames.length - 1], o.replace?.[1] ?? -Infinity) + FRAME_EPS;
  const kept = fc.keyframes.filter((k) => k.frame < lo || k.frame > hi);
  let added: Keyframe[] = frames.map((frame, i) => ({
    frame,
    value: values[i],
    interpolation: o.interpolation ?? 'LINEAR',
  }));
  if (o.clean) added = dropRedundantKeys(added);
  if (o.stats) {
    o.stats.keys += added.length;
    o.stats.modifiers += fc.modifiers?.length ?? 0;
  }
  const curve: FCurve = { ...fc, keyframes: [...kept, ...added].sort((a, b) => a.frame - b.frame) };
  delete curve.modifiers;
  doc.setFCurve(curve);
  if (doc.getDriver(key)) {
    doc.removeDriver(key);
    if (o.stats) o.stats.drivers++;
  }
  return added.length;
}

/**
 * Location and rotation_euler (closest to `oldRotation`) that give an object whose own scale is
 * `scale` the world matrix `world` under `parent` (null: no parent). The signs of that scale are
 * taken out of the matrix first, so that a mirrored object keeps its orientation.
 */
export function channelsFor(
  world: Readonly<Mat4>,
  parent: Readonly<Mat4> | null,
  scale: Readonly<Vec3>,
  oldRotation: Readonly<Vec3>,
): { location: Vec3; rotation_euler: Vec3 } {
  const m = [...world] as Mat4;
  for (let c = 0; c < 3; c++) if (scale[c] < 0) for (let r = 0; r < 3; r++) m[c * 4 + r] = -m[c * 4 + r];
  const t = worldMatrixToTransform(m, parent ? ([...parent] as Mat4) : null, [...oldRotation] as Vec3);
  return { location: t.location, rotation_euler: t.rotation_euler };
}

/** Samples of an object's location and rotation_euler channels, one per frame (see {@link keyTransforms}). */
export interface TransformSamples {
  frames: number[];
  location: Vec3[];
  rotation: Vec3[];
}

export function transformSamples(): TransformSamples {
  return { frames: [], location: [], rotation: [] };
}

/**
 * Keys an object's location and rotation_euler from samples (LINEAR; redundant keys dropped with
 * `clean`), replacing its keys in the sampled range (widened by `replace`). Returns the keys written.
 */
export function keyTransforms(
  doc: SceneDoc,
  id: string,
  s: TransformSamples,
  o: { clean?: boolean; replace?: [number, number]; stats?: KeyWriteStats } = {},
): number {
  let keys = 0;
  for (let i = 0; i < 3; i++) {
    keys += writeChannel(
      doc,
      id,
      'location',
      i,
      s.frames,
      s.location.map((v) => v[i]),
      o,
    );
    keys += writeChannel(
      doc,
      id,
      'rotation_euler',
      i,
      s.frames,
      s.rotation.map((v) => v[i]),
      o,
    );
  }
  return keys;
}

/** Whether a data path addresses constraint `name` (`constraints["name"].…`, either quote). */
export function isConstraintPath(path: string, name: string): boolean {
  return path.startsWith(`constraints["${name}"].`) || path.startsWith(`constraints['${name}'].`);
}

/** The F-curve keys and driver keys of an object's paths for which `match` holds. */
function channelKeys(
  doc: SceneDoc,
  id: string,
  match: (path: string) => boolean,
): { curves: string[]; drivers: string[] } {
  return {
    curves: doc
      .listFCurves(id)
      .filter((fc) => fc.target_type === 'object' && match(fc.path))
      .map((fc) => fcurveKey(fc)),
    drivers: doc
      .listDrivers(id)
      .filter((d) => d.target_type === 'object' && match(d.path))
      .map((d) => fcurveKey(d)),
  };
}

/**
 * The first frame at which the constraint `name` of object `o` may act (its influence above 0 there),
 * from its influence F-curve: the key before the first key above 0 (the curve rises from there), or
 * −Infinity when it acts before its first key, has no keys or is driven. Null when it never acts
 * (muted, or an influence that stays 0).
 */
export function constraintActiveFrom(doc: SceneDoc, o: ObjectData, name: string): number | null {
  const c = o.constraints.find((x) => x.name === name);
  if (!c || c.mute) return null;
  const { curves, drivers } = channelKeys(
    doc,
    o.id,
    (p) => isConstraintPath(p, name) && p.endsWith('.influence'),
  );
  if (drivers.length) return -Infinity;
  const fc = curves.length ? doc.getFCurve(curves[0]) : null;
  if (!fc || !fc.keyframes.length || fc.mute) return c.influence > 0 ? -Infinity : null;
  const keys = [...fc.keyframes].sort((a, b) => a.frame - b.frame);
  const first = keys.findIndex((k) => k.value > 0);
  if (first < 0) return null;
  // CONSTANT extrapolation holds the first key before it; LINEAR extrapolation may rise before it too
  if (first === 0) return -Infinity;
  return keys[first - 1].frame;
}

/**
 * Removes the constraints `names` of object `id` with their F-curves and drivers (the influence keys
 * of a hold, or any parameter keyed). Returns the names removed.
 */
export function removeConstraints(doc: SceneDoc, id: string, names: readonly string[]): string[] {
  const o = doc.getObject(id);
  if (!o || !names.length) return [];
  const drop = new Set(names);
  const removed = o.constraints.filter((c) => drop.has(c.name)).map((c) => c.name);
  if (!removed.length) return [];
  doc.updateObject(id, { constraints: o.constraints.filter((c) => !drop.has(c.name)) });
  const { curves, drivers } = channelKeys(doc, id, (p) => removed.some((n) => isConstraintPath(p, n)));
  for (const k of curves) doc.removeFCurve(k);
  for (const k of drivers) doc.removeDriver(k);
  return removed;
}

/**
 * Makes constraint `name` of object `id` act no more from `frame` on: its influence keyed at its
 * value one frame before (held there, CONSTANT) and 0 from `frame`, later keys dropped and a driver
 * of its influence removed. Before `frame` it acts as it did. Returns false when the constraint is
 * missing or muted.
 */
export function silenceConstraintFrom(doc: SceneDoc, id: string, name: string, frame: number): boolean {
  const o = doc.getObject(id);
  const c = o?.constraints.find((x) => x.name === name);
  if (!o || !c || c.mute) return false;
  const path = `constraints["${name}"].influence`;
  const existing = channelKeys(doc, id, (p) => isConstraintPath(p, name) && p.endsWith('.influence'));
  for (const k of existing.drivers) doc.removeDriver(k);
  const fc = existing.curves.length ? doc.getFCurve(existing.curves[0])! : null;
  const before = fc && fc.keyframes.length ? (evaluateFCurve(fc, frame - 1) ?? c.influence) : c.influence;
  const ref = fc ?? createFCurve({ target_type: 'object', target_id: id, path, index: 0 });
  const kept = ref.keyframes.filter((k) => k.frame < frame - 1 - FRAME_EPS);
  // the key before the hold keeps its own interpolation into it; the hold steps down at `frame`
  doc.setFCurve({
    ...ref,
    keyframes: [
      ...kept,
      { frame: frame - 1, value: before, interpolation: 'CONSTANT' },
      { frame, value: 0, interpolation: 'CONSTANT' },
    ],
  });
  return true;
}

/** The world matrix of object `id`'s parent at a frame state (identity: none), as its channels see it. */
export function parentMatrix(fs: FrameState, o: ObjectData): Mat4 | null {
  return o.parent && fs.byId.has(o.parent) ? fs.parent(o.id) : null;
}

/** `v` (a world-space direction) in the space of `m`'s columns (its inverse applied, translation left out). */
export function directionIn(m: Readonly<Mat4>, v: Readonly<Vec3>): Vec3 {
  const inv = invert4(m as Mat4);
  return [
    inv[0] * v[0] + inv[4] * v[1] + inv[8] * v[2],
    inv[1] * v[0] + inv[5] * v[1] + inv[9] * v[2],
    inv[2] * v[0] + inv[6] * v[1] + inv[10] * v[2],
  ];
}

/** Translation of a matrix. */
export const originOf = (m: Readonly<Mat4>): Vec3 => [m[12], m[13], m[14]];

/** `a · b` for 4×4 column-major matrices (re-exported for the presets). */
export const mul4 = (a: Readonly<Mat4>, b: Readonly<Mat4>): Mat4 => multiply4(a, b);

/** World-space bounds of a mesh object's mesh under world matrix `m` (null for objects without vertices). */
export function worldBounds(
  doc: SceneDoc,
  o: ObjectData,
  m: Readonly<Mat4>,
): { min: Vec3; max: Vec3 } | null {
  const mesh = o.type === 'MESH' && o.data ? doc.getMesh(o.data) : null;
  if (!mesh || !mesh.positions.length) return null;
  const P = mesh.positions;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v + 2 < P.length; v += 3) {
    for (let k = 0; k < 3; k++) {
      const w = m[k] * P[v] + m[4 + k] * P[v + 1] + m[8 + k] * P[v + 2] + m[12 + k];
      if (w < min[k]) min[k] = w;
      if (w > max[k]) max[k] = w;
    }
  }
  return { min, max };
}

/** Local-space bounds of a mesh object's mesh (null without vertices). */
export function localBounds(doc: SceneDoc, o: ObjectData): { min: Vec3; max: Vec3 } | null {
  return worldBounds(doc, o, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

/** The objects under `id` (children, grandchildren …), in breadth-first order. */
export function descendants(doc: SceneDoc, id: string): ObjectData[] {
  const index = doc.childrenIndex();
  const out: ObjectData[] = [];
  const queue = [...(index.get(id) ?? [])];
  const seen = new Set<string>([id]);
  while (queue.length) {
    const c = queue.shift()!;
    if (seen.has(c)) continue;
    seen.add(c);
    const o = doc.getObject(c);
    if (!o) continue;
    out.push(o);
    queue.push(...(index.get(c) ?? []));
  }
  return out;
}

/** An object's name without the '.001' suffix the document adds to keep names unique. */
export const baseName = (name: string): string => name.replace(/\.\d{3,}$/, '');

/** Custom property of a store model's root (store.add, store.insert_files): its store id. */
const STORE_ID_PROP = 'store_id';

/** Object types with geometry of their own (what a model shows). */
const GEOMETRY_TYPES: ReadonlySet<ObjectData['type']> = new Set(['MESH', 'CURVE', 'FONT']);

/**
 * The root of the store model whose geometry object `id` carries, or null (review F2): its nearest
 * ancestor that is an EMPTY with a store_id (the root store.add and store.insert_files return, which
 * shots, checks and agents follow), when every object with geometry under that root is `id` or under
 * it: a model of one mesh (a ball, a melon), or the main part the presets hang the other parts from
 * (presets.ts bodyObjectFor). A part simulated on its own (one wheel of a car) carries no root.
 */
export function modelRootOf(doc: SceneDoc, id: string): ObjectData | null {
  const seen = new Set<string>([id]);
  let root: ObjectData | null = null;
  for (let cur = doc.getObject(id); cur?.parent && !seen.has(cur.parent);) {
    seen.add(cur.parent);
    cur = doc.getObject(cur.parent);
    if (cur?.type === 'EMPTY' && typeof cur.custom_props?.[STORE_ID_PROP] === 'string') {
      root = cur;
      break;
    }
  }
  if (!root) return null;
  const carried = new Set([id, ...descendants(doc, id).map((d) => d.id)]);
  for (const d of descendants(doc, root.id))
    if (GEOMETRY_TYPES.has(d.type) && !carried.has(d.id)) return null;
  return root;
}

/**
 * The rigid frame of a world matrix: its origin and its rotation, scale and shear left out, by the
 * simulation's own decomposition (physics/vmath.ts decomposeRigid: Gram-Schmidt, X then Y), so that
 * the frame of a simulated body follows exactly the rotations the simulation gives it.
 */
export function rigidFrame(m: Readonly<Mat4>): Mat4 {
  const { position, rotation } = decomposeRigid(m);
  return composeRigid(position, rotation, [1, 1, 1]);
}
