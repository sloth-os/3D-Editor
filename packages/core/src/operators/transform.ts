import { z } from 'zod';
import type { Mat4, Vec3 } from '../math/types';
import { axisAngle4, compose4, identity4, invert4, multiply4, scaling4, translation4 } from '../math/mat4';
import { normalize3, transformDirection3, transformPoint3 } from '../math/vec3';
import {
  changedChannels,
  fcurveKey,
  orientationAxes,
  transformBasis,
  transformedChannels,
  transformTolerance,
  type SceneDoc,
  type TransformBasis,
  type TransformChannels,
  type TransformMode,
} from '../doc/scene-doc';
import type { ConstraintData, ObjectData } from '../doc/types';
import { FrameState } from '../eval/frame-state';
import { insertKeyframe } from '../anim/fcurve';
import { parseConstraintParams } from '../constraints/solve';
import { getConstraintTypeInfo } from '../constraints/catalogue';
import type { MeshData } from '../mesh/types';
import { cloneMesh, vertexCount } from '../mesh/types';
import { selectedVertexSet } from '../mesh/selection';
import type { EditorState, OperatorContext, PivotPoint } from './context';
import { OperatorError } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { activeObject, editTarget, selectedObjects, vec3 } from './helpers';
import { keyProperty } from './anim';

/*
 * Transform helpers shared by the transform operators (headless / MCP / redo panel) and the
 * interactive modal transform in the browser. Like Blender's, they work on what the scene shows at
 * the current frame (a FrameState): the values an animated object shows, the matrix of the bone an
 * object is parented to, animated, posed and constrained parents.
 */

/**
 * The world matrix of an object as the scene evaluates it at the frame of `fs` (animation,
 * parenting to objects and bones, poses and constraints), or from the stored values when it lies on
 * a dependency cycle (which the scene evaluates to no matrix).
 */
export function evaluatedWorld(fs: FrameState, id: string): Mat4 {
  return fs.world(id) ?? fs.doc.worldMatrix(id);
}

/**
 * World-space pivot for the current selection according to the pivot point setting, as Blender's
 * calculateCenter finds it at the current frame (`fs`, default a new one at the state's frame):
 * the 3D cursor; in Edit Mode the median (or bounding box center) of the selected vertices where the
 * scene shows them; else the median or bounding box center of the origins of the objects a
 * transform in `mode` transforms, without a selected child of a selected parent (it only follows
 * its parent, and a rotation about individual origins, which also turns it, leaves it out of the
 * center too; see {@link ObjectTransform.pivot}), with Active Element the active object's origin
 * (selected or not; the median without an active object).
 */
export function selectionPivot(
  doc: SceneDoc,
  state: EditorState,
  pivot: PivotPoint = state.pivotPoint,
  opts: { mode?: TransformMode; fs?: FrameState } = {},
): Vec3 {
  if (pivot === 'CURSOR') return [...state.cursorLocation] as Vec3;
  const fs = opts.fs ?? new FrameState(doc, state.frame);
  if (state.mode === 'EDIT' && state.activeId) {
    const o = doc.getObject(state.activeId);
    const mesh = o?.data ? doc.getMesh(o.data) : null;
    if (!o || !mesh) return [0, 0, 0];
    const mw = evaluatedWorld(fs, o.id);
    const verts = [...selectedVertexSet(mesh, state.meshSelection)].filter((v) => v < vertexCount(mesh));
    if (verts.length === 0) return transformPoint3(mw, [0, 0, 0]);
    const pts = verts.map((v) =>
      transformPoint3(mw, [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]]),
    );
    return centerOf(pts, pivot === 'BOUNDING_BOX_CENTER');
  }
  return new ObjectTransform(fs, state.selectedIds, pivot, opts.mode ?? 'TRANSLATE').pivot(state);
}

function centerOf(pts: Vec3[], bounds: boolean): Vec3 {
  if (pts.length === 0) return [0, 0, 0];
  if (bounds) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const p of pts)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k]);
        max[k] = Math.max(max[k], p[k]);
      }
    return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  }
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) c[k] += p[k];
  return [c[0] / pts.length, c[1] / pts.length, c[2] / pts.length];
}

/** Number of ancestors of an object at the frame of `fs` (a parent loop counts each object once). */
function depthOf(fs: FrameState, id: string): number {
  let d = 0;
  const seen = new Set([id]);
  for (
    let p = fs.byId.get(id)?.parent ?? null;
    p && !seen.has(p) && fs.byId.has(p);
    p = fs.byId.get(p)!.parent
  ) {
    seen.add(p);
    d++;
  }
  return d;
}

/** M about pivot: T(p) · M · T(-p). */
export function aboutPivot(m: Mat4, pivot: Vec3): Mat4 {
  return multiply4(translation4(pivot), multiply4(m, translation4([-pivot[0], -pivot[1], -pivot[2]])));
}

/**
 * Selected objects without those whose ancestor is also selected (they follow their parent), as
 * Blender's transforms leave those out (set_trans_object_base_flags). With `keepChildren` (a
 * rotation about individual origins, see {@link transformObjects}) they are kept.
 */
export function transformRoots(doc: SceneDoc, ids: string[], keepChildren = false): string[] {
  if (keepChildren) return ids.filter((id) => doc.getObject(id));
  const set = new Set(ids);
  return ids.filter((id) => {
    let p = doc.getObject(id)?.parent ?? null;
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      if (set.has(p)) return false;
      seen.add(p);
      p = doc.getObject(p)?.parent ?? null;
    }
    return true;
  });
}

/**
 * What Blender's Move, Rotate and Scale read from an object before they change its channels
 * (ObjectToTransData), at the frame of a FrameState (see {@link transformStart}).
 */
export interface TransformStart {
  id: string;
  /**
   * The channels the transform starts from: the values the object shows at the frame (animated and
   * driven ones included), as Blender's channels hold them. Its stored values where none is.
   */
  channels: TransformChannels;
  /**
   * The parent's matrix at the frame: an animated, posed or constrained parent where the scene
   * shows it, a bone's posed matrix (at the bone's tail) for an object parented to a bone. Null
   * without a parent.
   */
  parentWorld: Mat4 | null;
  /** The transform basis (td->center, smtx, mtx, axismtx; see transformBasis in scene-doc.ts). */
  basis: TransformBasis;
}

/**
 * Whether an object's constraints are part of the space a transform in `mode` moves it in, as
 * Blender's constraints_list_needinv decides (it then reads the object's matrix with them, and
 * converts offsets through them): Follow Path and Clamp To always, Child Of when it inherits the
 * location on all three axes, Copy Rotation mixed Before or Offset when rotating, Copy Transforms
 * mixed Before or Before Full when moving or rotating and Before Split when rotating. Otherwise
 * Blender switches the object's constraints off for this. Only constraints that act count: not
 * muted, with an influence, solved without an error at the frame (Blender leaves out disabled
 * ones, e.g. without a valid target).
 */
function constraintsInTransformSpace(fs: FrameState, o: ObjectData, mode: TransformMode): boolean {
  const list = Array.isArray(o.constraints) ? o.constraints : [];
  if (!list.length) return false;
  const failed = new Set((fs.constraintErrors.get(o.id) ?? []).map((e) => e.constraintId));
  return list.some((c, index) => {
    if (!c || typeof c !== 'object' || c.mute === true) return false;
    if (failed.has(typeof c.id === 'string' && c.id ? c.id : `#${index}`)) return false;
    const influence = c.influence === undefined ? 1 : c.influence;
    if (!(typeof influence === 'number' && influence > 0)) return false;
    const parsed = parseConstraintParams(c);
    if (!parsed.ok) return false;
    const p = parsed.params;
    switch (c.type) {
      case 'FOLLOW_PATH':
      case 'CLAMP_TO':
        return true;
      case 'CHILD_OF':
        return !!(p.use_location_x && p.use_location_y && p.use_location_z);
      case 'COPY_ROTATION':
        return mode === 'ROTATE' && (p.mix_mode === 'BEFORE' || p.mix_mode === 'OFFSET');
      case 'COPY_TRANSFORMS':
        return (
          ((mode === 'ROTATE' || mode === 'TRANSLATE') &&
            (p.mix_mode === 'BEFORE' || p.mix_mode === 'BEFORE_FULL')) ||
          (mode === 'ROTATE' && p.mix_mode === 'BEFORE_SPLIT')
        );
      default:
        return false;
    }
  });
}

/**
 * What a transform in `mode` reads from object `id` at the frame of `fs`, as Blender's
 * ObjectToTransData reads it: the channels the object shows there, its parent's matrix there (a
 * bone's posed matrix for a bone child) and the transform basis of its world matrix, parent · its
 * channels, read with its own constraints switched off unless they are part of the transform's
 * space ({@link constraintsInTransformSpace}); its axes (td->axismtx) are those it shows, its
 * constraints applied. An object on a dependency cycle (evaluated to no matrix) is read from its
 * stored values. Null when the object does not exist.
 */
export function transformStart(fs: FrameState, id: string, mode: TransformMode): TransformStart | null {
  const o = fs.byId.get(id);
  if (!o) return null;
  const hasParent = !!o.parent && o.parent !== id && fs.byId.has(o.parent);
  const shown = fs.world(id);
  if (!shown) {
    const stored = fs.doc.getObject(id);
    if (!stored) return null;
    const parentWorld = hasParent ? fs.doc.worldMatrix(o.parent!) : null;
    const local = compose4(stored.location, stored.rotation_euler, stored.scale);
    const world = parentWorld ? multiply4(parentWorld, local) : local;
    const channels = {
      location: stored.location,
      rotation_euler: stored.rotation_euler,
      scale: stored.scale,
    };
    return { id, channels, parentWorld, basis: transformBasis(channels, world, parentWorld) };
  }
  const channels = { location: o.location, rotation_euler: o.rotation_euler, scale: o.scale };
  const parentWorld = hasParent ? fs.parent(id) : null;
  const local = compose4(o.location, o.rotation_euler, o.scale);
  const constrained = constraintsInTransformSpace(fs, o, mode);
  const world = constrained ? shown : parentWorld ? multiply4(parentWorld, local) : local;
  return {
    id,
    channels,
    parentWorld,
    basis: transformBasis(channels, world, parentWorld, shown, constrained),
  };
}

/** An object's channels before and after an operator changed them (or left them as they were). */
export interface ChannelChange {
  before: TransformChannels;
  after: TransformChannels;
}

/**
 * A Move (`mode` TRANSLATE), Rotate (ROTATE) or Scale (RESIZE) of objects, as Blender's object
 * transform does it at the frame of `fs`: the objects it transforms (Blender's TransData: the given
 * objects without those whose parent or an ancestor is among them too, which follow it, except in a
 * rotation about individual origins, where they also turn about their own origins, see
 * {@link transformRoots}) and what it reads from each ({@link transformStart}). Every object's new
 * channels are computed from what it shows before the transform (its animated values at the frame,
 * where it is under a bone or an animated, posed or constrained parent), then written.
 */
export class ObjectTransform {
  /** The objects the transform transforms, parents before their children. */
  readonly targets: TransformStart[];
  private readonly byId = new Map<string, TransformStart>();
  /**
   * Selected children of selected parents kept in a rotation about individual origins (Blender's
   * BA_TRANSFORM_CHILD): they turn about their own origins but do not count for the pivot.
   */
  private readonly kept = new Set<string>();

  constructor(
    readonly fs: FrameState,
    ids: readonly string[],
    readonly pivotMode: PivotPoint,
    readonly mode: TransformMode,
  ) {
    const existing = ids.filter((id) => fs.byId.has(id));
    const keepChildren = pivotMode === 'INDIVIDUAL_ORIGINS' && mode === 'ROTATE';
    const roots = transformRoots(fs.doc, existing, keepChildren);
    const sorted = roots
      .map((id, i) => ({ id, i, d: depthOf(fs, id) }))
      .sort((a, b) => a.d - b.d || a.i - b.i);
    this.targets = [];
    for (const { id } of sorted) {
      const t = transformStart(fs, id, mode);
      if (!t) continue;
      this.targets.push(t);
      this.byId.set(id, t);
    }
    if (keepChildren) {
      const unkept = new Set(transformRoots(fs.doc, existing));
      for (const t of this.targets) if (!unkept.has(t.id)) this.kept.add(t.id);
    }
  }

  /** What the transform reads from one of its objects (undefined for an object it leaves out). */
  start(id: string): TransformStart | undefined {
    return this.byId.get(id);
  }

  /**
   * The pivot for `state`'s 3D cursor and active object, as Blender's calculateCenter finds it: the
   * cursor; with Active Element the active object's origin (where the transform reads it when it
   * transforms the active object, else where the scene shows it; selected or not); else the median
   * or bounding box center of the origins of the objects it transforms, without the selected
   * children a rotation about individual origins keeps (TD_NOCENTER, see {@link kept}; with
   * Individual Origins their median, which only places the gizmo and the modal tool's rotation
   * center). The world origin when it transforms no object.
   */
  pivot(state: Pick<EditorState, 'cursorLocation' | 'activeId'>): Vec3 {
    if (this.pivotMode === 'CURSOR') return [...state.cursorLocation] as Vec3;
    if (this.targets.length === 0) return [0, 0, 0];
    const active = state.activeId;
    if (this.pivotMode === 'ACTIVE_ELEMENT' && active && this.fs.byId.has(active)) {
      const own = this.byId.get(active);
      if (own) return [...own.basis.center] as Vec3;
      const w = evaluatedWorld(this.fs, active);
      return [w[12], w[13], w[14]];
    }
    return centerOf(
      this.targets.filter((t) => !this.kept.has(t.id)).map((t) => t.basis.center),
      this.pivotMode === 'BOUNDING_BOX_CENTER',
    );
  }

  /**
   * The channels each object the transform transforms gets from `m` about the world point `pivot`
   * (each about its own origin with Individual Origins): Blender's Move, Rotate and Scale (see
   * transformedChannels in scene-doc.ts), computed from what it shows before the transform.
   */
  channels(m: Readonly<Mat4>, pivot: Readonly<Vec3>): Map<string, TransformChannels> {
    const out = new Map<string, TransformChannels>();
    const individual = this.pivotMode === 'INDIVIDUAL_ORIGINS';
    for (const t of this.targets)
      out.set(
        t.id,
        transformedChannels(t.channels, t.basis, this.mode, m, individual ? t.basis.center : pivot),
      );
    return out;
  }

  /**
   * Applies the transform `m` about `pivot` (see {@link channels}), writing only the channels whose
   * values change by more than rounding (transformTolerance in scene-doc.ts): a move writes the
   * location; a rotation the rotation (the euler closest to the one shown) and a scale the scale,
   * and both the location too about another point than the object's own origin; a move by 0, a
   * rotation by 0 or by whole turns and a scale by 1 nothing (with the gimbal-lock exception that
   * transformTolerance describes). Returns, for every object it transforms (also one it writes
   * nothing to), the channels it showed before and those it shows afterwards: the new value of each
   * channel it wrote, the value shown before of the others (see {@link keyChannelChanges}).
   */
  apply(m: Readonly<Mat4>, pivot: Readonly<Vec3>): Map<string, ChannelChange> {
    const next = this.channels(m, pivot);
    const changes = new Map<string, ChannelChange>();
    const doc = this.fs.doc;
    doc.transact(() => {
      for (const t of this.targets) {
        const patch = changedChannels(t.channels, next.get(t.id)!, transformTolerance(t.basis));
        if (patch) doc.updateObject(t.id, patch);
        changes.set(t.id, { before: t.channels, after: { ...t.channels, ...patch } });
      }
    });
    return changes;
  }

  /**
   * The world matrices the scene evaluates at the frame once the objects the transform transforms
   * have `channels` (see {@link channels}) stored and keyed, for every object the transform can
   * move (see {@link affectedObjects}): a frame state with those channels replaced
   * (FrameStateOptions.channels), so children follow their parents' new matrices, an object
   * parented to a bone follows the bone as its armature moves or as its pose follows a moved
   * target, and constraints and drivers read the moved objects where they move to. Only these
   * objects are evaluated anew, the rest is read from the frame state the transform started from
   * (FrameStateOptions.affected): a move costs what these objects cost, whatever the size of the
   * scene. Objects on a dependency cycle, which the scene evaluates to no matrix, are left out.
   */
  worlds(channels: ReadonlyMap<string, TransformChannels>): Map<string, Mat4> {
    const fs = this.fs;
    const { order, set } = this.affectedObjects();
    const after = new FrameState(fs.doc, fs.frame, fs.simulated, { base: fs, channels, affected: set });
    const out = new Map<string, Mat4>();
    for (const id of order) {
      const world = after.world(id);
      if (world) out.set(id, world);
    }
    return out;
  }

  private affected: { order: string[]; set: Set<string> } | null = null;

  /**
   * The objects whose world matrices the transform can change: those it transforms and every object
   * that reads one of them, directly or through others: its children (also those parented to a bone
   * of a moved armature), the owners of constraints that target it (object constraints, and an
   * armature whose bone constraints target it: its pose and so its bone children follow) and the
   * objects whose drivers read its channels (drivers of the object, or of the curve datablock of a
   * curve object: its path changes). In dependency order (each after the ones it reads;
   * those on a dependency cycle, and those reading them, last), so evaluating them in turn does not
   * recurse deeply.
   */
  private affectedObjects(): { order: string[]; set: Set<string> } {
    if (this.affected) return this.affected;
    const fs = this.fs;
    const readers = new Map<string, string[]>();
    const reads = (reader: string, id: unknown) => {
      if (typeof id !== 'string' || id === reader || !fs.byId.has(id)) return;
      const list = readers.get(id);
      if (list) list.push(reader);
      else readers.set(id, [reader]);
    };
    const constraintTargets = (reader: string, list: unknown) => {
      if (!Array.isArray(list)) return;
      for (const c of list as ConstraintData[]) {
        if (!c || typeof c !== 'object') continue;
        reads(reader, c.target);
        for (const k of getConstraintTypeInfo(c.type)?.objectParams ?? []) reads(reader, c.params?.[k]);
      }
    };
    // the curve objects of each curve datablock: a driver of the curve (its evaluation time, say)
    // changes the path that Follow Path and Clamp To read from them
    const curveUsers = new Map<string, string[]>();
    for (const o of fs.objects) {
      reads(o.id, o.parent);
      constraintTargets(o.id, o.constraints);
      for (const b of Object.values(o.pose?.bones ?? {})) constraintTargets(o.id, b?.constraints);
      const users = o.type === 'CURVE' && o.data ? curveUsers.get(o.data) : undefined;
      if (users) users.push(o.id);
      else if (o.type === 'CURVE' && o.data) curveUsers.set(o.data, [o.id]);
    }
    for (const d of fs.doc.listDrivers()) {
      if (d.mute) continue;
      const owners =
        d.target_type === 'object'
          ? [d.target_id]
          : d.target_type === 'curve'
            ? curveUsers.get(d.target_id)
            : [];
      for (const owner of owners ?? [])
        for (const v of d.variables ?? []) if (v.target_type === 'object') reads(owner, v.target_id);
    }
    const set = new Set(this.targets.map((t) => t.id));
    const queue = [...set];
    for (let i = 0; i < queue.length; i++)
      for (const r of readers.get(queue[i]) ?? [])
        if (!set.has(r)) {
          set.add(r);
          queue.push(r);
        }
    // Kahn's algorithm over the relations among them
    const waiting = new Map<string, number>(queue.map((id) => [id, 0]));
    for (const id of queue) for (const r of readers.get(id) ?? []) waiting.set(r, waiting.get(r)! + 1);
    const order = queue.filter((id) => waiting.get(id) === 0);
    for (let i = 0; i < order.length; i++)
      for (const r of readers.get(order[i]) ?? []) {
        const left = waiting.get(r)! - 1;
        waiting.set(r, left);
        if (left === 0) order.push(r);
      }
    for (const id of queue) if (waiting.get(id)! > 0) order.push(id);
    return (this.affected = { order, set });
  }
}

/**
 * Moves (`mode` TRANSLATE: `m` is a world translation), rotates (ROTATE) or scales (RESIZE: `m`'s
 * 3×3 part is the world rotation or scale) objects as they are at the frame of `fs` (default: a
 * FrameState at frame 1; the operators pass the editor's frame); children of transformed objects
 * follow them. With INDIVIDUAL_ORIGINS each object rotates or scales about its
 * own origin, otherwise about the world point `pivot`. Each object's channels change as Blender's
 * Move, Rotate and Scale change them, from what it shows at the frame, and only the channels whose
 * values change are written (see {@link ObjectTransform.apply}). A selected object whose parent (or
 * an ancestor) is selected too is left out and follows it, except in a rotation about individual
 * origins: as in Blender (BA_TRANSFORM_CHILD) it then turns about its own origin as well, by the same
 * rotation, in addition to following its parent (its location stays). As Blender does, every
 * object's new channels are computed from the matrices before the transform, then written. Returns
 * the channels every object it transforms showed before and shows afterwards (for keying, see
 * {@link keyChannelChanges}).
 */
export function transformObjects(
  doc: SceneDoc,
  ids: string[],
  m: Mat4,
  pivot: Vec3,
  pivotMode: PivotPoint,
  mode: TransformMode,
  fs: FrameState = new FrameState(doc, 1),
): Map<string, ChannelChange> {
  return new ObjectTransform(fs, ids, pivotMode, mode).apply(m, pivot);
}

const CHANNEL_PATHS = ['location', 'rotation_euler', 'scale'] as const;

/** One of an object's channels: its location, rotation or scale. */
export type ChannelPath = (typeof CHANNEL_PATHS)[number];

/**
 * Keys what an operator did to objects' channels at the current frame (`changes`: each object's
 * channels as it showed them before and as it shows them afterwards):
 * - with auto keying, the channels of `keyingSet` of every object in `changes`, with the values it
 *   shows afterwards, as Blender keys every object its transform transforms with the values its
 *   channels hold (an animated channel holds its value at the frame): also an object the operator
 *   left as it was (a rotation by 0 keys all nine channels);
 * - without it, each channel the operator changed that is already animated (keyed on an F-curve
 *   that is not muted, and not set by a driver), with its new value, so the object keeps showing
 *   what the operator did, as the editor's other tools keep edits of animated channels. Blender
 *   keeps such a change without a key until the frame changes, which the editor has no state for.
 */
export function keyChannelChanges(
  ctx: OperatorContext,
  changes: ReadonlyMap<string, ChannelChange>,
  keyingSet: readonly ChannelPath[] = CHANNEL_PATHS,
): void {
  const frame = ctx.state.frame;
  for (const [id, { before, after }] of changes) {
    if (ctx.state.autoKeying) {
      for (const path of keyingSet)
        for (let index = 0; index < 3; index++)
          keyProperty(ctx, 'object', id, path, frame, { index, value: after[path][index] });
      continue;
    }
    for (const path of CHANNEL_PATHS)
      for (let index = 0; index < 3; index++) {
        const value = after[path][index];
        if (value === before[path][index] || !Number.isFinite(value)) continue;
        const key = fcurveKey({ target_type: 'object', target_id: id, path, index });
        const fc = ctx.doc.getFCurve(key);
        if (!fc || fc.mute || fc.keyframes.length === 0) continue;
        const driver = ctx.doc.getDriver(key);
        if (driver && !driver.mute) continue;
        ctx.doc.setFCurve(insertKeyframe(fc, frame, value));
      }
  }
}

/**
 * Runs `change`, which changes the transform of object `id`, keeping the world matrices of its
 * children: each is read where the scene shows it before (from `before`, a FrameState from before
 * the operator changed anything, or a new one when the child is in `changed`, the objects whose
 * world matrices the operator changed already) and set relative to its parent matrix as the scene
 * evaluates it after the change (a bone child relative to its bone).
 */
export function keepChildrenWorld(
  ctx: OperatorContext,
  id: string,
  change: () => void,
  before: FrameState,
  changed: ReadonlySet<string>,
): void {
  const children = ctx.doc.childrenOf(id).map((c) => c.id);
  if (!children.length) return change();
  const fs = children.some((c) => changed.has(c)) ? new FrameState(ctx.doc, ctx.state.frame) : before;
  const worlds = children.map((c) => [c, evaluatedWorld(fs, c)] as const);
  change();
  const after = new FrameState(ctx.doc, ctx.state.frame);
  for (const [c, w] of worlds) ctx.doc.setWorldMatrix(c, w, after.parent(c));
}

/**
 * Moves object `id`'s origin by `target`, a vector in its own space, as Blender's Set Origin does:
 * its location grows by the move taken into its parent's space by its own rotation and scale
 * (location + R·S·target), whatever its parent is, so the origin moves onto the point and nothing
 * moves visually; its children keep their world matrices (see {@link keepChildrenWorld}). The
 * location, rotation and scale are those the object shows at the frame (from `before`, read again
 * when the operator changed its parent already), as Blender's channels hold an animated object's
 * values there; an animated location keeps its keys, which go on deciding where the object is (as
 * in Blender once the frame changes).
 */
export function moveOrigin(
  ctx: OperatorContext,
  id: string,
  target: Vec3,
  before: FrameState,
  changed: Set<string>,
): void {
  const stored = ctx.doc.getObject(id);
  if (!stored) return;
  // a child of an object whose origin moved before has had its stored channels rewritten
  const fs = stored.parent && changed.has(stored.parent) ? new FrameState(ctx.doc, ctx.state.frame) : before;
  const shown = fs.byId.get(id);
  const o = shown
    ? { location: shown.location, rotation_euler: shown.rotation_euler, scale: shown.scale }
    : stored;
  const d = transformDirection3(compose4([0, 0, 0], o.rotation_euler, o.scale), target);
  const location: Vec3 = [o.location[0] + d[0], o.location[1] + d[1], o.location[2] + d[2]];
  keepChildrenWorld(
    ctx,
    id,
    () => {
      // a move below rounding (an origin already there) writes nothing
      const patch = changedChannels(o, { ...o, location }, 1e-12);
      if (patch) ctx.doc.updateObject(id, patch);
    },
    before,
    changed,
  );
  changed.add(id);
}

export type Falloff = EditorState['proportionalFalloff'];

export function falloffWeight(t: number, falloff: Falloff): number {
  const x = Math.max(0, Math.min(1, t));
  switch (falloff) {
    case 'CONSTANT':
      return 1;
    case 'LINEAR':
      return 1 - x;
    case 'SHARP':
      return (1 - x) * (1 - x);
    case 'ROOT':
      return Math.sqrt(1 - x);
    case 'SPHERE':
      return Math.sqrt(Math.max(0, 1 - x * x));
    case 'SMOOTH':
    default:
      return 3 * (1 - x) * (1 - x) - 2 * (1 - x) * (1 - x) * (1 - x);
  }
}

export interface VertexTransformOptions {
  proportional?: boolean;
  proportionalSize?: number;
  falloff?: Falloff;
}

/**
 * Applies a world-space transform about `pivot` to the selected vertices of a mesh whose object
 * has world matrix `objWorld`. Supports proportional editing (weights by distance to the nearest
 * selected vertex). Returns a new mesh.
 */
export function transformVertices(
  mesh: MeshData,
  verts: Set<number>,
  objWorld: Mat4,
  m: Mat4,
  pivot: Vec3,
  opts: VertexTransformOptions = {},
): MeshData {
  const out = cloneMesh(mesh);
  const inv = invert4(objWorld);
  // Local-space transform: L = W⁻¹ · (T(p)·M·T(-p)) · W
  const local = multiply4(inv, multiply4(aboutPivot(m, pivot), objWorld));
  const n = vertexCount(mesh);
  const P = mesh.positions;
  const apply = (i: number, w: number) => {
    const src: Vec3 = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
    const dst = transformPoint3(local, src);
    out.positions[i * 3] = src[0] + (dst[0] - src[0]) * w;
    out.positions[i * 3 + 1] = src[1] + (dst[1] - src[1]) * w;
    out.positions[i * 3 + 2] = src[2] + (dst[2] - src[2]) * w;
  };
  for (const i of verts) if (i < n) apply(i, 1);
  if (opts.proportional && verts.size > 0) {
    const radius = Math.max(1e-6, opts.proportionalSize ?? 1);
    const sel = [...verts].filter((i) => i < n);
    const world = (i: number) => transformPoint3(objWorld, [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
    const selWorld = sel.map(world);
    for (let i = 0; i < n; i++) {
      if (verts.has(i)) continue;
      const q = world(i);
      let best = Infinity;
      for (const s of selWorld) {
        const d = Math.hypot(q[0] - s[0], q[1] - s[1], q[2] - s[2]);
        if (d < best) best = d;
      }
      if (best < radius) apply(i, falloffWeight(best / radius, opts.falloff ?? 'SMOOTH'));
    }
  }
  return out;
}

/**
 * Orientation basis (columns X, Y, Z) for constraint axes: with LOCAL orientation the active
 * object's axes as {@link orientAxes} gives them, else the world axes.
 */
export function orientationMatrix(doc: SceneDoc, state: EditorState): Mat4 {
  if (state.transformOrientation !== 'LOCAL' || !state.activeId || !doc.getObject(state.activeId))
    return identity4();
  return orientAxes(new FrameState(doc, state.frame), state.activeId);
}

/**
 * The axes of Blender's LOCAL orientation for an active object: its world axes where the scene
 * shows it at the frame of `fs` (its constraints applied), each normalized, an axis it scales to 0
 * rebuilt from the others as Blender's transform_orientations_create_from_axis rebuilds it (one
 * zero axis: the cross product of the other two; two: the world axes made perpendicular to the
 * third), the world axes when all three are 0.
 */
export function orientAxes(fs: FrameState, activeId: string): Mat4 {
  return orientationAxes(evaluatedWorld(fs, activeId));
}

/**
 * Applies a world-space transform to the current selection as the scene shows it at the current
 * frame: edit-mode vertices (with the edited object's evaluated matrix), or objects as `mode`
 * (Move, Rotate or Scale, see {@link ObjectTransform}). Auto keying keys every object the
 * transform transforms, also one it writes nothing to; without it the animated channels it changes
 * are keyed at the frame (see {@link keyChannelChanges}).
 */
export function transformSelection(
  ctx: OperatorContext,
  mode: TransformMode,
  m: Mat4,
  pivotOverride?: Vec3,
): void {
  const { doc, state } = ctx;
  const fs = new FrameState(doc, state.frame);
  if (state.mode === 'EDIT') {
    const t = editTarget(ctx);
    const verts = selectedVertexSet(t.mesh, t.selection);
    if (verts.size === 0) throw new OperatorError('No vertices selected', 'POLL_FAILED');
    const pivot = pivotOverride ?? selectionPivot(doc, state, state.pivotPoint, { mode, fs });
    const mesh = transformVertices(t.mesh, verts, evaluatedWorld(fs, t.object.id), m, pivot, {
      proportional: state.proportionalEditing,
      proportionalSize: state.proportionalSize,
      falloff: state.proportionalFalloff,
    });
    doc.setMesh(t.meshId, mesh);
    return;
  }
  const ids = selectedObjects(ctx).map((o) => o.id);
  if (ids.length === 0) throw new OperatorError('No objects selected', 'POLL_FAILED');
  const xf = new ObjectTransform(fs, ids, state.pivotPoint, mode);
  // auto keying keys every object the transform transforms, also by 0, as Blender's does, not the
  // selected children that only follow their parents; without it the animated channels it changed
  keyChannelChanges(ctx, xf.apply(m, pivotOverride ?? xf.pivot(state)));
}

/** What the object transforms' descriptions say about the frame they work at and keying. */
const KEYING =
  ' Objects are transformed from where the scene shows them at the current frame (in the axes of a ' +
  'parent bone or of an animated parent). A channel that is already animated is keyed at the current frame ' +
  'with its new value, so the object stays where it is put; with auto keying all channels of every ' +
  'transformed object are keyed.';

const orientEnum = z.enum(['GLOBAL', 'LOCAL']).default('GLOBAL');
const axisEnum = z.enum(['X', 'Y', 'Z']);

function pollTransform(ctx: OperatorContext): true | string {
  if (ctx.state.mode === 'EDIT') return activeObject(ctx)?.type === 'MESH' ? true : 'No mesh in edit mode';
  if (ctx.state.mode !== 'OBJECT') return 'Transform is not available in this mode';
  return selectedObjects(ctx).length > 0 ? true : 'No objects selected';
}

/**
 * The axes of the transform orientation `orient`: the world axes (GLOBAL), or the active object's
 * as Blender's LOCAL orientation gives them (see {@link orientAxes}; the world axes without an
 * active object).
 */
function orientationOf(ctx: OperatorContext, orient: 'GLOBAL' | 'LOCAL'): Mat4 {
  const o = orient === 'LOCAL' ? activeObject(ctx) : null;
  return o ? orientAxes(new FrameState(ctx.doc, ctx.state.frame), o.id) : identity4();
}

export function registerTransformOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'transform.translate',
      label: 'Move',
      description:
        'Move selected objects (or selected vertices in Edit Mode) by a world-space offset.' + KEYING,
      category: 'Transform',
      redoable: true,
      schema: z.object({
        value: vec3.default([0, 0, 0]),
        orient_type: orientEnum,
      }),
      poll: pollTransform,
      execute(ctx, p) {
        let v = p.value as Vec3;
        if (p.orient_type === 'LOCAL') v = transformDirection3(orientationOf(ctx, 'LOCAL'), v);
        transformSelection(ctx, 'TRANSLATE', translation4(v));
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'transform.rotate',
      label: 'Rotate',
      description:
        'Rotate the selection around an axis through the pivot point. `value` is in radians.' + KEYING,
      category: 'Transform',
      redoable: true,
      schema: z.object({
        value: z.number().default(0),
        orient_axis: axisEnum.default('Z'),
        orient_type: orientEnum,
        axis: vec3.optional().describe('Arbitrary world-space rotation axis (overrides orient_axis)'),
        center: vec3.optional().describe('Optional world-space pivot override'),
      }),
      poll: pollTransform,
      execute(ctx, p) {
        const k = p.orient_axis === 'X' ? 0 : p.orient_axis === 'Y' ? 1 : 2;
        // a unit axis of the orientation (LOCAL rebuilds an axis the active object scales to 0)
        const o = p.orient_type === 'LOCAL' ? orientationOf(ctx, 'LOCAL') : identity4();
        let axis: Vec3 = [o[k * 4], o[k * 4 + 1], o[k * 4 + 2]];
        if (p.axis) {
          axis = normalize3(p.axis as Vec3);
          if (axis[0] === 0 && axis[1] === 0 && axis[2] === 0)
            throw new OperatorError('Rotation axis must not be zero', 'INVALID_PARAMS');
        }
        transformSelection(ctx, 'ROTATE', axisAngle4(axis, p.value), p.center as Vec3 | undefined);
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'transform.resize',
      label: 'Scale',
      description: 'Scale the selection about the pivot point.' + KEYING,
      category: 'Transform',
      redoable: true,
      schema: z.object({
        value: vec3.default([1, 1, 1]),
        center: vec3.optional(),
      }),
      poll: pollTransform,
      execute(ctx, p) {
        transformSelection(ctx, 'RESIZE', scaling4(p.value as Vec3), p.center as Vec3 | undefined);
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'object.transform_set',
      label: 'Set Transform',
      description:
        'Set location / rotation_euler (radians) / scale of objects directly (local space). Omitted values are kept. ' +
        'Applies to `objects` (ids or names) or to the selection. With auto keying the location, rotation and scale ' +
        'are keyed at the current frame; without it a channel that is already animated is keyed there with its new ' +
        'value, so the object shows it.',
      category: 'Object',
      schema: z.object({
        objects: z.array(z.string()).optional(),
        location: vec3.optional(),
        rotation_euler: vec3.optional(),
        scale: vec3.optional(),
      }),
      execute(ctx, p) {
        const ids = (p.objects?.length ? p.objects : ctx.state.selectedIds).map((r) => {
          const o = ctx.doc.resolveObject(r);
          if (!o) throw new OperatorError(`Object '${r}' not found`, 'NOT_FOUND');
          return o.id;
        });
        if (ids.length === 0) throw new OperatorError('No objects given or selected', 'POLL_FAILED');
        // keyed as the transforms key (keyChannelChanges): with auto keying the values the objects
        // show afterwards, the ones set and the others as they are at the current frame (an animated
        // channel's value there, not its stored one); without it the animated channels it changes
        const before = new FrameState(ctx.doc, ctx.state.frame);
        const changes = new Map<string, ChannelChange>();
        for (const id of ids) {
          const patch: Record<string, unknown> = {};
          if (p.location) patch.location = p.location;
          if (p.rotation_euler) patch.rotation_euler = p.rotation_euler;
          if (p.scale) patch.scale = p.scale;
          const o = before.byId.get(id);
          if (o)
            changes.set(id, {
              before: { location: o.location, rotation_euler: o.rotation_euler, scale: o.scale },
              after: {
                location: (p.location as Vec3 | undefined) ?? o.location,
                rotation_euler: (p.rotation_euler as Vec3 | undefined) ?? o.rotation_euler,
                scale: (p.scale as Vec3 | undefined) ?? o.scale,
              },
            });
          ctx.doc.updateObject(id, patch);
        }
        keyChannelChanges(ctx, changes);
      },
    }),
  );
}
