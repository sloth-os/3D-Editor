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
import type { ConstraintData, FCurve, ObjectData } from '../doc/types';
import { FrameState } from '../eval/frame-state';
import { createFCurve, evaluateFCurve, insertKeyframe } from '../anim/fcurve';
import { constraintTargets, parseConstraintParams } from '../constraints/solve';
import { matrixToEuler } from '../constraints/math';
import { RigidBodySimulator } from '../physics/rigid-body';
import { sanitizeRigidBodyWorld } from '../physics/settings';
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
  const fs = opts.fs ?? transformFrameState(doc, state.frame);
  if (state.mode === 'EDIT' && state.activeId) {
    const o = doc.getObject(state.activeId);
    const mesh = o?.data ? doc.getMesh(o.data) : null;
    if (!o || !mesh) return [0, 0, 0];
    const mw = shownWorld(fs, o.id);
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
   * driven ones included), as Blender's channels hold them. Its stored values where none is. For a
   * rigid body the simulation moves at the frame, the location and rotation where the simulation
   * shows it (see {@link transformStart}).
   */
  channels: TransformChannels;
  /**
   * The values the object's channels hold at the frame before the transform (animated and driven
   * ones included): `channels`, except for a rigid body the simulation moves, whose channels hold
   * where it starts the simulation. The transform writes the channels whose new values differ from
   * these.
   */
  held: TransformChannels;
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
 *
 * A rigid body whose matrix the simulation sets at the frame (`fs.simulated`, see
 * {@link transformFrameState}) starts where the simulation shows it: as Blender's ObjectToTransData
 * does while the simulation runs ("Update object's loc/rot to get current rigid body transform"),
 * its location and rotation are read from that matrix (taken into its parent's space, which Blender
 * leaves out; its scale stays), so a transform moves it on from there and stores where it puts it.
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
    return { id, channels, held: channels, parentWorld, basis: transformBasis(channels, world, parentWorld) };
  }
  const held = { location: o.location, rotation_euler: o.rotation_euler, scale: o.scale };
  const parentWorld = hasParent ? fs.parent(id) : null;
  if (fs.simulated?.get(id) === shown) {
    const local = parentWorld ? multiply4(invert4(parentWorld), shown) : [...shown];
    // the scale stays the channels' (mirrored axes keep their sign)
    for (let c = 0; c < 3; c++) if (o.scale[c] < 0) for (let r = 0; r < 3; r++) local[c * 4 + r] *= -1;
    const channels = {
      location: [local[12], local[13], local[14]] as Vec3,
      rotation_euler: matrixToEuler(local),
      scale: o.scale,
    };
    return { id, channels, held, parentWorld, basis: transformBasis(channels, shown, parentWorld) };
  }
  const local = compose4(o.location, o.rotation_euler, o.scale);
  const constrained = constraintsInTransformSpace(fs, o, mode);
  const world = constrained ? shown : parentWorld ? multiply4(parentWorld, local) : local;
  return {
    id,
    channels: held,
    held,
    parentWorld,
    basis: transformBasis(held, world, parentWorld, shown, constrained),
  };
}

/**
 * The world matrices the rigid body simulation gives the scene's bodies at `frame` (null when it
 * runs at no body there: no enabled rigid body world, no rigid body among `objects`, or `frame` not
 * after the world's frame_start), from the document's shared simulation cache, so only frames not
 * simulated yet are simulated. A simulation that fails gives null (the viewport reports its error).
 */
function simulatedAt(doc: SceneDoc, frame: number, objects: readonly ObjectData[]): Map<string, Mat4> | null {
  if (!sanitizeRigidBodyWorld(doc.getScene().rigidbody_world).enabled) return null;
  if (!objects.some((o) => o.rigid_body?.enabled)) return null;
  try {
    return new RigidBodySimulator().evaluate(doc, frame, {
      transformsAt: (f) => new FrameState(doc, f).allWorldMatrices(),
      meshOf: (id) => {
        const o = doc.getObject(id);
        return o?.type === 'MESH' && o.data ? doc.getMesh(o.data) : null;
      },
    });
  } catch {
    return null;
  }
}

/**
 * The frame state Move, Rotate, Scale, their pivots and the LOCAL orientation read the scene from
 * at `frame`: what the viewport shows there, rigid bodies where the simulation has them included
 * (see {@link transformStart}). The document is read once.
 */
export function transformFrameState(doc: SceneDoc, frame: number): FrameState {
  const fs = new FrameState(doc, frame);
  const simulated = simulatedAt(doc, frame, fs.objects);
  return simulated ? new FrameState(doc, frame, simulated, { base: fs }) : fs;
}

/**
 * What evaluating the scene at the frame of a FrameState reads, as a graph of nodes, each listing
 * the nodes that read it (see {@link sceneRelations}).
 */
interface SceneRelations {
  readers: Map<string, string[]>;
  /** The armature of a bone node or an IK chain node. */
  armatures: Map<string, string>;
  /** The nodes on a dependency cycle (in a strongly connected component of two or more nodes). */
  cyclic: Set<string>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The node of what an animation driver variable reads or what a driver writes. */
const animNode = (type: string, id: string) => (type === 'object' ? `chan:${id}` : `${type}:${id}`);

/**
 * The relations of the scene at the frame of `fs` that its evaluation follows, as a graph whose
 * nodes are an object's channels (`chan:<id>`, its animated and driven values), its world matrix
 * (`object:<id>`, with a curve object's path), a bone's posed matrix (`bone:<armature>:<bone>`), the
 * solution of the IK chains the pose evaluator solves together, those sharing bones
 * (`ik:<armature>:<bone>:<n>`, after the first of them), an armature's whole pose (`pose:<id>`) and
 * each other datablock with animated or driven values (`<type>:<id>`: curves, meshes' shape keys,
 * materials, lights, cameras, the world, the scene). A node is read by: for channels, the object's
 * matrix and the datablocks whose drivers read them (drivers read channels, never matrices); for a
 * matrix, the objects parented to the object, those whose constraints target it and the bones of an
 * armature (an armature's bones read its matrix and the objects their constraints target); for a
 * bone, its child bones, the objects parented to it, the IK solutions and constraints that target
 * it (also of its own chain, a cycle) and its armature's pose; for an IK solution, the bones of its
 * chains; for a pose, the objects whose constraints read a bone in LOCAL space; for a curve
 * datablock, the matrices (paths) of the curve objects using it; for other datablocks, those whose
 * drivers read them. Muted constraints and those without influence count too (animation can turn
 * them on); muted drivers do not.
 */
function sceneRelations(fs: FrameState): SceneRelations {
  const readers = new Map<string, string[]>();
  const armatures = new Map<string, string>();
  const link = (from: string, to: string) => {
    if (from === to) return;
    const list = readers.get(from);
    if (list) list.push(to);
    else readers.set(from, [to]);
  };
  const exists = (id: unknown): id is string => typeof id === 'string' && fs.byId.has(id);
  const bone = (arm: string, name: string) => {
    const key = `bone:${arm}:${name}`;
    armatures.set(key, arm);
    return key;
  };
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
  /** What a constraint of `owner` (an object, or a bone of armature `owner`) reads. */
  const sources = (owner: string, c: Record<string, unknown>, bones: boolean): string[] => {
    const out: string[] = [];
    const subtarget = typeof c.subtarget === 'string' ? c.subtarget : '';
    const params = isRecord(c.params) ? c.params : {};
    const read = (target: unknown, sub: string) => {
      if (!exists(target)) return;
      if (target === owner) {
        // a bone constraint targeting a bone of its own armature (or the armature's matrix)
        if (bones) out.push(sub ? bone(owner, sub) : `object:${owner}`);
        return;
      }
      out.push(`object:${target}`);
      if (sub && fs.byId.get(target)?.type === 'ARMATURE') out.push(bone(target, sub));
    };
    read(c.target, subtarget);
    for (const t of constraintTargets(c as unknown as ConstraintData))
      if (t !== c.target)
        read(
          t,
          t === params.pole_target && typeof params.pole_subtarget === 'string' ? params.pole_subtarget : '',
        );
    // an object constraint reading a bone in LOCAL space reads the armature's whole pose (the
    // bone's parent chain through the evaluated pose: FrameState.pose)
    const local = params.target_space === 'LOCAL' || c.target_space === 'LOCAL';
    if (!bones && subtarget && local && exists(c.target) && c.target !== owner) {
      armatures.set(`pose:${c.target}`, c.target);
      out.push(`pose:${c.target}`);
    }
    return out;
  };
  for (const o of fs.objects) {
    const matrix = `object:${o.id}`;
    link(`chan:${o.id}`, matrix);
    if (exists(o.parent) && o.parent !== o.id) {
      link(`object:${o.parent}`, matrix);
      if (o.parent_type === 'BONE' && o.parent_bone) link(bone(o.parent, o.parent_bone), matrix);
    }
    for (const c of list(o.constraints)) for (const s of sources(o.id, c, false)) link(s, matrix);
    if (o.type === 'CURVE' && typeof o.data === 'string') link(`curve:${o.data}`, matrix);
    const arm = o.type === 'ARMATURE' && o.data ? fs.doc.getArmature(o.data) : null;
    if (!arm) continue;
    const parentOf = new Map<string, string>();
    for (const b of list(arm.bones)) {
      if (typeof b.name !== 'string') continue;
      link(matrix, bone(o.id, b.name));
      link(bone(o.id, b.name), `pose:${o.id}`);
      if (typeof b.parent === 'string' && b.parent) {
        parentOf.set(b.name, b.parent);
        link(bone(o.id, b.parent), bone(o.id, b.name));
      }
    }
    const poseBones = isRecord(o.pose?.bones) ? o.pose!.bones : {};
    const chains: { job: string; reads: string[]; bones: string[] }[] = [];
    for (const [name, pb] of Object.entries(poseBones)) {
      const node = bone(o.id, name);
      list(isRecord(pb) ? pb.constraints : null).forEach((c, n) => {
        const reads = sources(o.id, c, true);
        if (c.type !== 'IK') {
          for (const s of reads) link(s, node);
          return;
        }
        const params = isRecord(c.params) ? c.params : {};
        const chain: string[] = [];
        let tip = params.use_tail === false ? (parentOf.get(name) ?? null) : name;
        const count = typeof params.chain_count === 'number' ? params.chain_count : 0;
        for (; tip && !chain.includes(tip); tip = parentOf.get(tip) ?? null) {
          chain.push(tip);
          if (count > 0 && chain.length >= count) break;
        }
        chains.push({ job: `ik:${o.id}:${name}:${n}`, reads, bones: chain });
      });
    }
    // the IK chains sharing bones are solved together, as one job (the pose evaluator's buildJobs),
    // from their targets and poles, the parents of their bones and the bones' own constraints; the
    // job sets all their bones
    const group = chains.map((_, i) => i);
    const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i])));
    const chainOf = new Map<string, number>();
    chains.forEach((ch, i) => {
      for (const b of ch.bones) {
        const other = chainOf.get(b);
        if (other === undefined) chainOf.set(b, i);
        else group[find(i)] = find(other);
      }
    });
    const jobs = new Map<number, { job: string; bones: Set<string> }>();
    chains.forEach((ch, i) => {
      let job = jobs.get(find(i));
      if (!job) {
        jobs.set(find(i), (job = { job: ch.job, bones: new Set() }));
        armatures.set(ch.job, o.id);
        link(matrix, ch.job);
      }
      for (const s of ch.reads) link(s, job.job);
      for (const b of ch.bones) job.bones.add(b);
    });
    for (const { job, bones } of jobs.values())
      for (const b of bones) {
        link(job, bone(o.id, b));
        const p = parentOf.get(b);
        if (p !== undefined && !bones.has(p)) link(bone(o.id, p), job);
        for (const other of list(isRecord(poseBones[b]) ? poseBones[b].constraints : null))
          if (other.type !== 'IK') for (const s of sources(o.id, other, true)) link(s, job);
      }
  }
  for (const d of fs.doc.listDrivers()) {
    if (d.mute) continue;
    const owner = animNode(d.target_type, d.target_id);
    for (const v of Array.isArray(d.variables) ? d.variables : [])
      if (v && typeof v.target_id === 'string') link(animNode(v.target_type, v.target_id), owner);
  }
  return { readers, armatures, cyclic: cyclicNodes(readers) };
}

/**
 * The nodes of `graph` in a strongly connected component of two or more nodes (Tarjan, iterative,
 * on the nodes numbered).
 */
function cyclicNodes(graph: ReadonlyMap<string, readonly string[]>): Set<string> {
  const ids = new Map<string, number>();
  const names: string[] = [];
  const idOf = (n: string): number => {
    let i = ids.get(n);
    if (i === undefined) {
      ids.set(n, (i = names.length));
      names.push(n);
    }
    return i;
  };
  const edges: (number[] | undefined)[] = [];
  for (const [node, readers] of graph) edges[idOf(node)] = readers.map(idOf);
  const count = names.length;
  const index = new Int32Array(count).fill(-1);
  const low = new Int32Array(count);
  const onStack = new Uint8Array(count);
  const stack = new Int32Array(count);
  const work = new Int32Array(count);
  const next = new Int32Array(count);
  const out = new Set<string>();
  let counter = 0;
  let top = 0;
  for (let root = 0; root < count; root++) {
    if (index[root] >= 0) continue;
    let depth = 0;
    work[depth++] = root;
    index[root] = low[root] = counter++;
    stack[top++] = root;
    onStack[root] = 1;
    while (depth) {
      const v = work[depth - 1];
      const list = edges[v];
      if (list && next[v] < list.length) {
        const w = list[next[v]++];
        if (index[w] < 0) {
          index[w] = low[w] = counter++;
          stack[top++] = w;
          onStack[w] = 1;
          work[depth++] = w;
        } else if (onStack[w] && index[w] < low[v]) low[v] = index[w];
        continue;
      }
      depth--;
      if (depth && low[v] < low[work[depth - 1]]) low[work[depth - 1]] = low[v];
      if (low[v] !== index[v]) continue;
      const first = top;
      let w: number;
      do {
        w = stack[--top];
        onStack[w] = 0;
      } while (w !== v);
      if (first - top > 1) for (let k = top; k < first; k++) out.add(names[stack[k]]);
    }
  }
  return out;
}

/** The relations of the scene at the frame of `fs` (see {@link sceneRelations}), computed once. */
const relationsOfState = new WeakMap<FrameState, SceneRelations>();
function relationsOf(fs: FrameState): SceneRelations {
  let r = relationsOfState.get(fs);
  if (!r) relationsOfState.set(fs, (r = sceneRelations(fs)));
  return r;
}

/**
 * The nodes whose evaluation reads a node on a dependency cycle, directly or through others, the
 * nodes on cycles included (see {@link sceneRelations}): what evaluating one of these gives
 * depends on where the evaluation enters the cycle. Empty without a cycle; computed once.
 */
const readersOfCycles = new WeakMap<SceneRelations, ReadonlySet<string>>();
function cycleReaders(relations: SceneRelations): ReadonlySet<string> {
  const known = readersOfCycles.get(relations);
  if (known) return known;
  const { readers, cyclic } = relations;
  const queue = [...cyclic];
  const found = new Set(queue);
  for (let i = 0; i < queue.length; i++)
    for (const r of readers.get(queue[i]) ?? [])
      if (!found.has(r)) {
        found.add(r);
        queue.push(r);
      }
  readersOfCycles.set(relations, found);
  return found;
}

/** Whether evaluating `node` (see {@link sceneRelations}) reads a dependency cycle. */
function readsCycle(relations: SceneRelations, node: string): boolean {
  return relations.cyclic.size > 0 && cycleReaders(relations).has(node);
}

/**
 * Evaluates every object of `fs` in the document's order (once), as the viewport and the
 * operators' evaluation of the scene do: what is read from `fs` afterwards is what the scene shows,
 * also where it reads a dependency cycle (see {@link readsCycle}).
 */
const settledStates = new WeakSet<FrameState>();
function settle(fs: FrameState): void {
  if (settledStates.has(fs)) return;
  settledStates.add(fs);
  for (const o of fs.objects) fs.world(o.id);
}

/**
 * The world matrix of object `id` where the scene shows it at the frame of `fs` (see
 * {@link evaluatedWorld}), for `fs` a frame state that has not evaluated the object yet: where
 * evaluating it reads a dependency cycle (see {@link sceneRelations}), what evaluation gives can
 * depend on the order objects are evaluated in (an object parented to a bone of a pose cycle shows
 * no matrix when evaluated first), so `fs` then first evaluates every object in the document's
 * order, as the viewport does (see {@link ObjectTransform}). The matrix of an object without a
 * parent, constraints or drivers of its channels reads nothing else: no relations are needed. The
 * Edit Mode pivot and transform and the LOCAL orientation ({@link orientAxes}) read the object so.
 */
export function shownWorld(fs: FrameState, id: string): Mat4 {
  const o = fs.byId.get(id);
  const readsOthers =
    !!o &&
    (!!o.parent ||
      !!o.constraints?.length ||
      fs.doc.listDrivers().some((d) => !d.mute && animNode(d.target_type, d.target_id) === `chan:${id}`));
  if (readsOthers && readsCycle(relationsOf(fs), `object:${id}`)) settle(fs);
  return evaluatedWorld(fs, id);
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
  /** What the scene's evaluation reads (see {@link sceneRelations}). */
  private readonly relations: SceneRelations;

  /**
   * Reads what the transform starts from at the frame of `fs`, a frame state nothing has read
   * world matrices from yet. Where what an object the transform transforms shows reads a
   * dependency cycle (see {@link sceneRelations}), what evaluation gives depends on the order
   * objects are evaluated in (the cycle breaks where it is entered): `fs` then first evaluates
   * every object in the document's order, as the viewport and the operators' evaluation of the
   * scene do, so the transform starts from what the scene shows ({@link settle}). A cycle elsewhere
   * in the scene costs nothing more.
   */
  constructor(
    readonly fs: FrameState,
    ids: readonly string[],
    readonly pivotMode: PivotPoint,
    readonly mode: TransformMode,
  ) {
    this.relations = relationsOf(fs);
    const existing = ids.filter((id) => fs.byId.has(id));
    const keepChildren = pivotMode === 'INDIVIDUAL_ORIGINS' && mode === 'ROTATE';
    const roots = transformRoots(fs.doc, existing, keepChildren);
    if (roots.some((id) => this.readsCycle(`object:${id}`))) this.settle();
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

  /** Whether evaluating `node` (see {@link sceneRelations}) reads a dependency cycle. */
  private readsCycle(node: string): boolean {
    return readsCycle(this.relations, node);
  }

  /**
   * Evaluates every object of the frame state the transform starts from, `fs`, in the document's
   * order (once), as the viewport and the operators' evaluation of the scene do: what is read from
   * `fs` afterwards is what the scene shows, also where it reads a dependency cycle (see
   * {@link readsCycle}).
   */
  private settle(): void {
    settle(this.fs);
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
      if (this.readsCycle(`object:${active}`)) this.settle();
      const w = evaluatedWorld(this.fs, active);
      return [w[12], w[13], w[14]];
    }
    return centerOf(
      this.targets.filter((t) => !this.kept.has(t.id)).map((t) => t.basis.center),
      this.pivotMode === 'BOUNDING_BOX_CENTER',
    );
  }

  /**
   * The channels each object the transform transforms holds once `m` about the world point `pivot`
   * (each about its own origin with Individual Origins) is applied ({@link apply}): Blender's Move,
   * Rotate and Scale (see transformedChannels in scene-doc.ts), computed from what it shows before
   * the transform, of which only the channels whose values change by more than rounding
   * (transformTolerance in scene-doc.ts) take the new values; the others keep, exactly, the values
   * they hold before ({@link TransformStart.held}).
   */
  channels(m: Readonly<Mat4>, pivot: Readonly<Vec3>): Map<string, TransformChannels> {
    const out = new Map<string, TransformChannels>();
    const individual = this.pivotMode === 'INDIVIDUAL_ORIGINS';
    for (const t of this.targets) {
      const next = transformedChannels(
        t.channels,
        t.basis,
        this.mode,
        m,
        individual ? t.basis.center : pivot,
      );
      out.set(t.id, { ...t.held, ...changedChannels(t.held, next, transformTolerance(t.basis)) });
    }
    return out;
  }

  /**
   * Applies the transform `m` about `pivot`, writing the channels that {@link channels} changes: a
   * move writes the location; a rotation the rotation (the euler closest to the one shown) and a
   * scale the scale, and both the location too about another point than the object's own origin; a
   * move by 0, a rotation by 0 or by whole turns and a scale by 1 nothing (with the gimbal-lock
   * exception that transformTolerance describes). A rigid body the simulation moves also gets the
   * location and rotation it starts from, where the simulation shows it, as Blender's channels keep
   * them (see {@link transformStart}). Returns, for every object it transforms (also one it writes
   * nothing to), the values its channels held before and those they hold afterwards: the new value
   * of each channel it wrote, the value held before of the others (see {@link keyChannelChanges}).
   */
  apply(m: Readonly<Mat4>, pivot: Readonly<Vec3>): Map<string, ChannelChange> {
    const next = this.channels(m, pivot);
    const changes = new Map<string, ChannelChange>();
    const doc = this.fs.doc;
    doc.transact(() => {
      for (const t of this.targets) {
        const after = next.get(t.id)!;
        const patch = changedChannels(t.held, after);
        if (patch) doc.updateObject(t.id, patch);
        changes.set(t.id, { before: t.held, after });
      }
    });
    return changes;
  }

  /**
   * The world matrices the scene evaluates at the frame once the objects the transform transforms
   * have `channels` (see {@link channels}) stored and keyed as confirming keys them (with auto
   * keying, `opts.autoKeying`, or without; see {@link keyed}), for every object the transform can
   * move (see {@link affectedObjects}): a frame state with those channels replaced
   * (FrameStateOptions.channels), so children follow their parents' new matrices, an object
   * parented to a bone follows the bone as its armature moves or as its pose follows a moved
   * target, and constraints and drivers read the moved objects where they move to, also through
   * other datablocks (a driver reading a curve, light or material whose driver reads a moved
   * object). A rigid body the transform moves follows its channels, without the simulation, as in
   * Blender while it is being transformed (FrameStateOptions.unsimulated). Only these objects are
   * evaluated anew, the rest is read from the frame state the transform started from
   * (FrameStateOptions.affected; where they read a dependency cycle, as the scene evaluates it in
   * the document's order, see {@link affectedObjects}): a move costs what these objects cost,
   * whatever the size of the scene. Where a dependency cycle runs through what these objects
   * evaluate anew (see {@link affectedObjects}), whose result depends on the order of evaluation,
   * every object is evaluated anew in the document's order instead, as the scene is once the
   * transform is confirmed: a move then costs what evaluating the scene costs. Objects on a
   * dependency cycle that this evaluation leaves without a matrix are left out.
   */
  worlds(
    channels: ReadonlyMap<string, TransformChannels>,
    opts: { autoKeying?: boolean } = {},
  ): Map<string, Mat4> {
    const fs = this.fs;
    const { order, set, data, cyclic, unsimulated } = this.affectedObjects();
    const replaced = new Map<string, TransformChannels>();
    for (const [id, c] of channels) {
      const t = this.byId.get(id);
      replaced.set(id, t ? this.keyed(t, c, !!opts.autoKeying) : c);
    }
    const out = new Map<string, Mat4>();
    if (cyclic) {
      const full = new FrameState(fs.doc, fs.frame, fs.simulated, {
        base: fs,
        channels: replaced,
        unsimulated,
      });
      for (const o of full.objects) full.world(o.id);
      for (const id of order) {
        const world = full.world(id);
        if (world) out.set(id, world);
      }
      return out;
    }
    const after = new FrameState(fs.doc, fs.frame, fs.simulated, {
      base: fs,
      channels: replaced,
      affected: set,
      affectedData: data,
      unsimulated,
    });
    for (const id of order) {
      const world = after.world(id);
      if (world) out.set(id, world);
    }
    return out;
  }

  /**
   * The stored channels, F-curves and drivers of the channels of the objects the transform
   * transforms (`curves` and `driven` by channel, location first; null without an F-curve or a
   * driver on any channel).
   */
  private readonly animation = new Map<
    string,
    { stored: TransformChannels; curves: (FCurve | null)[]; driven: boolean[] } | null
  >();

  /**
   * The values the channels of target `t` hold at the frame, before its drivers apply, once
   * {@link apply} has stored `after` (see {@link channels}) and {@link keyChannelChanges} has keyed
   * it, with auto keying (`autoKeying`) or without: where a channel is keyed, the value its F-curve
   * gives at the frame with the new key; else what its F-curve gives there, else its stored value
   * (the new one where the transform writes it).
   */
  private keyed(t: TransformStart, after: TransformChannels, autoKeying: boolean): TransformChannels {
    let anim = this.animation.get(t.id);
    if (anim === undefined) {
      const doc = this.fs.doc;
      const curves: (FCurve | null)[] = [];
      const driven: boolean[] = [];
      for (const path of CHANNEL_PATHS)
        for (let index = 0; index < 3; index++) {
          const key = fcurveKey({ target_type: 'object', target_id: t.id, path, index });
          const driver = doc.getDriver(key);
          curves.push(doc.getFCurve(key));
          driven.push(!!driver && !driver.mute);
        }
      const o = curves.some(Boolean) || driven.some(Boolean) ? doc.getObject(t.id) : null;
      anim = o && {
        stored: { location: o.location, rotation_euler: o.rotation_euler, scale: o.scale },
        curves,
        driven,
      };
      this.animation.set(t.id, anim);
    }
    // without F-curves and drivers its channels hold their stored values, `after` (where the
    // channels it does not write keep the values they held, the stored ones), keyed or not
    if (!anim) return after;
    const written = changedChannels(t.held, after) ?? {};
    const frame = this.fs.frame;
    const out = { ...after };
    CHANNEL_PATHS.forEach((path, p) => {
      out[path] = [0, 1, 2].map((index) => {
        const value = after[path][index];
        const fc = anim.curves[p * 3 + index];
        const keys =
          autoKeying ||
          (!!fc &&
            !fc.mute &&
            fc.keyframes.length > 0 &&
            value !== t.held[path][index] &&
            Number.isFinite(value) &&
            !anim.driven[p * 3 + index]);
        const curve = keys
          ? insertKeyframe(
              fc ?? createFCurve({ target_type: 'object', target_id: t.id, path, index }),
              frame,
              value,
            )
          : fc;
        const animated =
          curve && !curve.mute && curve.keyframes.length > 0 ? evaluateFCurve(curve, frame) : undefined;
        return animated ?? (written[path] ? value : anim!.stored[path][index]);
      }) as Vec3;
    });
    return out;
  }

  private affected: {
    order: string[];
    set: Set<string>;
    data: Set<string>;
    cyclic: boolean;
    unsimulated: Set<string>;
  } | null = null;

  /**
   * What the transform can change (see {@link sceneRelations}): the objects it transforms and every
   * object that reads one of them, directly or through others, through any datablock: the objects
   * whose matrices read theirs (children, also those parented to a bone of a moved armature, and
   * the owners of constraints that target them), the armatures whose bones read them (bone
   * constraints and IK chains: their poses, and so their bone children, follow), the objects whose
   * drivers read their channels or those of any datablock whose drivers read them (curves, meshes'
   * shape keys, materials, lights, cameras, the world, the scene), and the
   * curve objects whose curve datablock is among those (their paths, which Follow Path and Clamp
   * To read). `set`: those objects, in `order` each after the ones it reads (those on a dependency
   * cycle last), so evaluating them in turn does not recurse deeply; `data`: the other datablocks
   * among them (`<type>:<id>`); `cyclic`: whether a dependency cycle runs through what an overlay
   * evaluates anew, all of each object in `set` (its values, matrix and pose, also where the
   * transform does not reach them) and the datablocks in `data`; `unsimulated`: the rigid bodies
   * the transform moves whose matrices the simulation sets. Where what an overlay evaluates anew
   * reads a dependency cycle it does not run through, the frame state the transform started from,
   * which the overlay reads the cycle from, evaluates every object in the document's order first
   * ({@link settle}).
   */
  private affectedObjects(): NonNullable<ObjectTransform['affected']> {
    if (this.affected) return this.affected;
    const fs = this.fs;
    const { readers, armatures, cyclic } = this.relations;
    const objectOf = (node: string): string | null =>
      node.startsWith('object:')
        ? node.slice(7)
        : node.startsWith('chan:')
          ? node.slice(5)
          : (armatures.get(node) ?? null);
    const queue = this.targets.map((t) => `chan:${t.id}`);
    const visited = new Set(queue);
    for (let i = 0; i < queue.length; i++)
      for (const r of readers.get(queue[i]) ?? [])
        if (!visited.has(r)) {
          visited.add(r);
          queue.push(r);
        }
    const set = new Set<string>();
    const data = new Set<string>();
    for (const node of queue) {
      const id = objectOf(node);
      if (id === null) data.add(node);
      else if (fs.byId.has(id)) set.add(id);
    }
    // Kahn's algorithm over the relations among them; an object comes with its matrix (an armature
    // whose matrix stays with its first bone)
    const waiting = new Map<string, number>(queue.map((n) => [n, 0]));
    for (const n of queue) for (const r of readers.get(n) ?? []) waiting.set(r, waiting.get(r)! + 1);
    const nodes = queue.filter((n) => waiting.get(n) === 0);
    for (let i = 0; i < nodes.length; i++)
      for (const r of readers.get(nodes[i]) ?? []) {
        const left = waiting.get(r)! - 1;
        waiting.set(r, left);
        if (left === 0) nodes.push(r);
      }
    for (const n of queue) if (waiting.get(n)! > 0) nodes.push(n);
    const order: string[] = [];
    const listed = new Set<string>();
    for (const n of nodes) {
      if (n.startsWith('chan:')) continue;
      const id = objectOf(n);
      if (id !== null && set.has(id) && !listed.has(id)) {
        listed.add(id);
        order.push(id);
      }
    }
    // an overlay evaluates the objects in `set` anew, all of each (its values, matrix and pose, also
    // where the transform does not reach them), and the datablocks in `data`: where one of these is
    // on a dependency cycle, what it gives depends on where its evaluation enters the cycle
    const evaluatedAnew = (n: string) => {
      const id = objectOf(n);
      return id === null ? visited.has(n) : set.has(id);
    };
    let touchesCycle = false;
    for (const n of cyclic)
      if (evaluatedAnew(n)) {
        touchesCycle = true;
        break;
      }
    // else, where what the overlay evaluates anew reads a dependency cycle (one it does not evaluate
    // anew), it reads what the cycle gives from `fs`, which must give what the scene shows
    if (!touchesCycle && [...cycleReaders(this.relations)].some(evaluatedAnew)) this.settle();
    const unsimulated = new Set(this.targets.filter((t) => fs.simulated?.has(t.id)).map((t) => t.id));
    return (this.affected = { order, set, data, cyclic: touchesCycle, unsimulated });
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
 * - with auto keying (`autoKeying`, default the editor's setting), the channels of `keyingSet` of
 *   every object in `changes`, with the values it shows afterwards, as Blender keys every object
 *   its transform transforms with the values its channels hold (an animated channel holds its
 *   value at the frame): also an object the operator left as it was (a rotation by 0 keys all nine
 *   channels);
 * - without it, each channel the operator changed that is already animated (keyed on an F-curve
 *   that is not muted, and not set by a driver), with its new value, so the object keeps showing
 *   what the operator did, as the editor's other tools keep edits of animated channels. Blender
 *   keeps such a change without a key until the frame changes, which the editor has no state for.
 *   Operators that Blender's auto keying leaves alone (Set Origin, Apply Transform) pass
 *   `autoKeying` false.
 */
export function keyChannelChanges(
  ctx: OperatorContext,
  changes: ReadonlyMap<string, ChannelChange>,
  keyingSet: readonly ChannelPath[] = CHANNEL_PATHS,
  autoKeying: boolean = ctx.state.autoKeying,
): void {
  const frame = ctx.state.frame;
  for (const [id, { before, after }] of changes) {
    if (autoKeying) {
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

/** The values object `id`'s channels hold at the frame of `fs` (its stored ones if it has none). */
function heldChannels(fs: FrameState, id: string): TransformChannels | null {
  const o = fs.byId.get(id) ?? fs.doc.getObject(id);
  return o ? { location: o.location, rotation_euler: o.rotation_euler, scale: o.scale } : null;
}

/**
 * Runs `change`, which changes the transform of object `id`, keeping the world matrices of its
 * children: each is read where the scene shows it before (from `before`, a FrameState from before
 * the operator changed anything, or a new one when the child is in `changed`, the objects whose
 * world matrices the operator changed already) and set relative to its parent matrix as the scene
 * evaluates it after the change (a bone child relative to its bone), from the values its channels
 * hold at the frame. An animated channel of a child that this changes is keyed at the current
 * frame with its new value, as the operators keep edits of animated channels (keyChannelChanges
 * without auto keying, which Blender's Set Origin and Apply Transform do not key with).
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
  const worlds = children.map((c) => [c, evaluatedWorld(fs, c), heldChannels(fs, c)] as const);
  change();
  const after = new FrameState(ctx.doc, ctx.state.frame);
  const changes = new Map<string, ChannelChange>();
  for (const [c, w, held] of worlds) {
    const patch = ctx.doc.setWorldMatrix(c, w, after.parent(c), held ?? undefined);
    if (patch && held) changes.set(c, { before: held, after: { ...held, ...patch } });
  }
  keyChannelChanges(ctx, changes, CHANNEL_PATHS, false);
}

/**
 * Moves object `id`'s origin by `target`, a vector in its own space, as Blender's Set Origin does:
 * its location grows by the move taken into its parent's space by its own rotation and scale
 * (location + R·S·target), whatever its parent is, so the origin moves onto the point and nothing
 * moves visually at the frame; its children keep their world matrices (see
 * {@link keepChildrenWorld}). The location, rotation and scale are those the object shows at the
 * frame (from `before`, read again when the operator changed its parent already), as Blender's
 * channels hold an animated object's values there. An animated location is keyed at the current
 * frame with its new value (keyChannelChanges without auto keying), so the geometry stays where it
 * shows there; Blender keeps the new value without a key until the frame changes, then its keys
 * decide again. Either way the location's other keys do not change, so at those keyframes the
 * geometry, which moved for good, shows moved by the opposite of the origin's move.
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
      if (!patch) return;
      ctx.doc.updateObject(id, patch);
      keyChannelChanges(ctx, new Map([[id, { before: o, after: { ...o, ...patch } }]]), CHANNEL_PATHS, false);
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
  return orientAxes(transformFrameState(doc, state.frame), state.activeId);
}

/**
 * The axes of Blender's LOCAL orientation for an active object: its world axes where the scene
 * shows it at the frame of `fs` (its constraints applied; where it reads a dependency cycle, as the
 * viewport shows it, see {@link shownWorld}), each normalized, an axis it scales to 0 rebuilt from
 * the others as Blender's transform_orientations_create_from_axis rebuilds it (one zero axis: the
 * cross product of the other two; two: the world axes made perpendicular to the third), the world
 * axes when all three are 0.
 */
export function orientAxes(fs: FrameState, activeId: string): Mat4 {
  return orientationAxes(shownWorld(fs, activeId));
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
  const fs = transformFrameState(doc, state.frame);
  if (state.mode === 'EDIT') {
    const t = editTarget(ctx);
    const verts = selectedVertexSet(t.mesh, t.selection);
    if (verts.size === 0) throw new OperatorError('No vertices selected', 'POLL_FAILED');
    const pivot = pivotOverride ?? selectionPivot(doc, state, state.pivotPoint, { mode, fs });
    const mesh = transformVertices(t.mesh, verts, shownWorld(fs, t.object.id), m, pivot, {
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
  'parent bone or of an animated parent; a rigid body after the start frame of the simulation from where ' +
  'the simulation shows it, its new location and rotation becoming where the simulation starts it). A ' +
  'channel that is already animated is keyed at the current frame ' +
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
  return o ? orientAxes(transformFrameState(ctx.doc, ctx.state.frame), o.id) : identity4();
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
