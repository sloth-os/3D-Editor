import { z } from 'zod';
import * as Y from 'yjs';
import type { Mat4, Vec3 } from '../math/types';
import {
  axisAngle4,
  compose4,
  decompose4,
  identity4,
  invert4,
  multiply4,
  scaling4,
  translation4,
} from '../math/mat4';
import { cross3, dot3, length3, normalize3, transformDirection3, transformPoint3 } from '../math/vec3';
import {
  changedChannels,
  dataKindOf,
  transformBasis,
  transformedChannels,
  transformTolerance,
  type SceneDoc,
  type TransformBasis,
  type TransformChannels,
} from '../doc/scene-doc';
import { invertSafe, linearPart, matrixFromAxes, matrixToStoredEuler } from '../constraints/math';
import type { DatablockKind, ObjectData, ObjectType } from '../doc/types';
import { defaultObject } from '../doc/defaults';
import { meshStats, type MeshData, type MeshStats } from '../mesh/types';
import { SceneEvaluator, type EvaluatedObject, type EvaluatedScene } from '../eval/evaluate';
import { FrameState } from '../eval/frame-state';
import { newId } from '../util/id';
import { cloneJson } from '../util/json';
import type { OperatorContext } from './context';
import { OperatorError } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { pollObjectMode, resolveObjectIds, setSelection, vec3 } from './helpers';
import { autoKeyTransforms, rekeyAnimated } from './anim';
import { remapDuplicatedReferences } from './armature';
import { Rng } from '../generate/random';
import {
  type AlignMode,
  type Bounds,
  type TrackAxis,
  type UpAxis,
  boundsCenter,
  boundsGap,
  boundsSize,
  boundsValue,
  decomposeCompatible,
  distributeDeltas,
  emptyBounds,
  isEmptyBounds,
  pointsBounds,
  rotationBetween,
  sampleSurface,
  trackRotation,
  unionBounds,
} from '../generate/layout';
import {
  SceneRaycaster,
  WorldTriangles,
  computeDrop,
  triangleSetDistance,
  type RaycastTarget,
  type SceneHit,
} from '../generate/spatial';

/*
 * Scene layout tools for placing objects precisely (especially by AI agents): align, distribute,
 * drop to ground, snap to a surface, look at, randomize transform, array placement, scattering
 * real copies over a surface and setting dimensions, plus read-only queries (measure, ray cast,
 * statistics). Positions and bounds always come from the evaluated scene at the current frame
 * (animation, constraints and modifiers applied); edits are written to the objects' own transform
 * through their parents, and keyed like the transform operators (auto keying, or re-keying
 * channels that are already animated).
 */

/** Most objects an array_place / scatter_on_surface run may create. */
export const MAX_LAYOUT_OBJECTS = 10_000;

/** array_place CIRCLE angles this close to ±2π (radians) count as a full turn. */
export const FULL_TURN_TOLERANCE = 0.01;
/** scene.measure: most objects whose pairwise distances are listed, and the surface distance budget. */
const MEASURE_MAX_PAIR_OBJECTS = 25;
const MEASURE_SURFACE_BUDGET_MS = 3000;

const AXES = ['X', 'Y', 'Z'] as const;
const AXIS_INDEX = { X: 0, Y: 1, Z: 2 } as const;

const objectsParam = z
  .array(z.string())
  .optional()
  .describe('Objects by id or exact name (default: the selected objects)');

/** Micrometre rounding for reported numbers (hides float noise; never returns −0). */
const round = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 || 0 : v);
const r3 = (v: Readonly<Vec3>): Vec3 => [round(v[0]), round(v[1]), round(v[2])];
const boundsOut = (b: Bounds) => ({ min: r3(b.min), max: r3(b.max) });

/** Transform values as stored: −0 becomes 0 (keeps documents canonical across JSON round trips). */
function clean3(v: Readonly<Vec3>): Vec3 {
  return [v[0] || 0, v[1] || 0, v[2] || 0];
}

function translationOf(m: Readonly<Mat4>): Vec3 {
  return [m[12], m[13], m[14]];
}

/** Unit world direction of an object axis (column of its world matrix). */
function axisOf(m: Readonly<Mat4>, k: number): Vec3 {
  const x = m[k * 4];
  const y = m[k * 4 + 1];
  const z = m[k * 4 + 2];
  const l = Math.hypot(x, y, z);
  return l > 1e-12 ? [x / l, y / l, z / l] : k === 2 ? [0, 0, 1] : k === 1 ? [0, 1, 0] : [1, 0, 0];
}

/**
 * Evaluated scene plus the transform edits made during one operator run. Every edit records the
 * world-space change it applied, so objects whose ancestors were edited earlier in the same run see
 * their up-to-date world matrix and bounds (e.g. aligning a parent and its child together).
 */
class LayoutScene {
  readonly ev: EvaluatedScene;
  private fsCache: FrameState | null = null;
  private readonly log: { id: string; change: Mat4 }[] = [];
  private readonly editedIds = new Set<string>();
  private readonly ancestorCache = new Map<string, string[]>();
  private readonly pointCache = new Map<string, ArrayLike<number> | null>();

  /** `frame`: the frame to evaluate (default: the current frame; the read-only queries take one). */
  constructor(
    private readonly ctx: OperatorContext,
    private readonly frame: number = ctx.state.frame,
  ) {
    this.ev = new SceneEvaluator(ctx.doc).evaluate(frame);
  }

  /** Transform state of the frame, only built for bone parents (the evaluated scene has the rest). */
  private get fs(): FrameState {
    return (this.fsCache ??= new FrameState(this.ctx.doc, this.frame));
  }

  get(id: string): EvaluatedObject {
    const o = this.ev.byId.get(id);
    if (!o) throw new OperatorError(`Object '${id}' not found`, 'NOT_FOUND');
    return o;
  }

  /** Ancestor ids, nearest first. */
  ancestors(id: string): string[] {
    let out = this.ancestorCache.get(id);
    if (!out) {
      out = [];
      const seen = new Set([id]);
      let p = this.ev.byId.get(id)?.data.parent ?? null;
      while (p && !seen.has(p) && this.ev.byId.has(p)) {
        out.push(p);
        seen.add(p);
        p = this.ev.byId.get(p)?.data.parent ?? null;
      }
      this.ancestorCache.set(id, out);
    }
    return out;
  }

  /** Ids sorted parents first (stable), so edits to ancestors are seen by their descendants. */
  byDepth(ids: readonly string[]): string[] {
    return ids
      .map((id, i) => ({ id, i, d: this.ancestors(id).length }))
      .sort((a, b) => a.d - b.d || a.i - b.i)
      .map((x) => x.id);
  }

  /** Changes applied (in this run) to `id` itself when `self`, and to its ancestors, in edit order. */
  private accumulated(id: string, self: boolean): Mat4 | null {
    if (this.editedIds.size === 0) return null;
    const anc = this.ancestors(id);
    if (!(self && this.editedIds.has(id)) && !anc.some((a) => this.editedIds.has(a))) return null;
    const set = new Set(anc);
    if (self) set.add(id);
    let m: Mat4 | null = null;
    for (const e of this.log) if (set.has(e.id)) m = m ? multiply4(e.change, m) : e.change;
    return m;
  }

  /** Current world matrix (evaluated, plus the edits of this run). */
  world(id: string): Mat4 {
    const w = this.get(id).worldMatrix;
    const acc = this.accumulated(id, true);
    return acc ? multiply4(acc, w) : w.slice();
  }

  /** Current world matrix of the object's parent (bone tail for bone parents; identity when none). */
  parentWorld(id: string): Mat4 {
    const o = this.get(id).data;
    const evParent = o.parent && o.parent !== id ? this.ev.byId.get(o.parent) : undefined;
    let p: Mat4;
    if (!evParent || this.ancestors(o.parent!).includes(id)) p = identity4();
    else if (o.parent_type === 'BONE' && o.parent_bone) p = this.fs.parent(id);
    else p = evParent.worldMatrix;
    const acc = this.accumulated(id, false);
    return acc ? multiply4(acc, p) : p;
  }

  private record(id: string, change: Mat4): void {
    this.log.push({ id, change });
    this.editedIds.add(id);
  }

  /**
   * Moves an object by a world-space offset (its rotation and scale fields stay untouched). The new
   * location starts from the evaluated (animated) value, so keyed channels move as seen.
   */
  translate(id: string, delta: Readonly<Vec3>): void {
    if (!delta.every(Number.isFinite) || (delta[0] === 0 && delta[1] === 0 && delta[2] === 0)) return;
    const stored = this.ctx.doc.getObject(id);
    // once edited in this run the stored value is current; before that the animated one is
    const o = this.editedIds.has(id) ? stored : this.ev.byId.get(id)?.data;
    if (!o || !stored) return;
    const basis = this.basis(id, o);
    const moved = transformedChannels(o, basis, 'TRANSLATE', translation4(delta), [0, 0, 0]);
    // a move by less than rounding (an object already where it goes) writes nothing
    const patch = changedChannels(stored, { ...stored, location: moved.location }, transformTolerance(basis));
    if (patch) this.ctx.doc.updateObject(id, { location: clean3(patch.location!) });
    this.record(id, translation4(delta));
  }

  /** The transform basis of an object with channels `o` (see transformBasis in scene-doc.ts). */
  private basis(id: string, o: TransformChannels): TransformBasis {
    return transformBasis(o, this.world(id), this.hasParent(id) ? this.parentWorld(id) : null);
  }

  /**
   * Writes new channels of an object: each one whose value differs from the stored one. `o` is what
   * they were computed from (the stored values once edited in this run, else the animated ones): a
   * channel the edit leaves as it was keeps the value it shows, which only differs from the stored
   * one when it is animated (keying then sees the value the object shows, as for an edit of it). The
   * change of the object's world matrix is recorded for the edits that follow in this run.
   */
  private writeChannels(id: string, o: TransformChannels, next: TransformChannels, tol: number): void {
    const stored = this.ctx.doc.getObject(id);
    if (!stored) return;
    const patch = changedChannels(stored, next, tol);
    if (patch)
      this.ctx.doc.updateObject(
        id,
        Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, clean3(v as Vec3)])),
      );
    const parent = this.hasParent(id) ? this.parentWorld(id) : identity4();
    const before = multiply4(parent, compose4(o.location, o.rotation_euler, o.scale));
    const after = multiply4(parent, compose4(next.location, next.rotation_euler, next.scale));
    this.record(id, multiply4(after, invertSafe(before)));
  }

  /** Whether the object has a parent in the evaluated scene (that is not a cycle back to it). */
  private hasParent(id: string): boolean {
    const p = this.get(id).data.parent;
    return !!p && p !== id && this.ev.byId.has(p) && !this.ancestors(p).includes(id);
  }

  /**
   * Turns an object by the world rotation `r` (3×3 part) about the world point `pivot`, then moves
   * it by the world offset `offset`, as Blender's Rotate and Move change its channels
   * (transformedChannels in scene-doc.ts): the rotation becomes the euler closest to the current
   * one of the turn taken into the parent's space and applied to the current rotation, the location
   * changes only by the offset of the origin, and the scale stays. Only the channels whose values
   * change are written (see {@link writeChannels}).
   */
  turn(id: string, r: Readonly<Mat4>, pivot: Readonly<Vec3>, offset: Readonly<Vec3> = [0, 0, 0]): void {
    if (![...r, ...pivot, ...offset].every(Number.isFinite)) return;
    const stored = this.ctx.doc.getObject(id);
    // once edited in this run the stored value is current; before that the animated one is
    const o = this.editedIds.has(id) ? stored : this.ev.byId.get(id)?.data;
    if (!o || !stored) return;
    const basis = this.basis(id, o);
    let next = transformedChannels(o, basis, 'ROTATE', r, pivot);
    if (offset.some((v) => v !== 0))
      next = transformedChannels(next, basis, 'TRANSLATE', translation4(offset), pivot);
    this.writeChannels(id, o, next, transformTolerance(basis));
  }

  /**
   * Turns an object about its origin so its `track` axis points along the world direction `dir` and
   * its `up` axis as close as possible to world +Z (see trackRotation; `fallbackUp` when `dir` is
   * vertical), keeping its location and scale: only the rotation can change. The rotation is found
   * in the parent's space (the tracked axis exact also under a parent scaled unevenly, the up axis
   * the closest one perpendicular to it there), as the euler closest to the current one; a mirrored
   * object stays mirrored on the third axis. False when `dir` is zero.
   */
  aim(id: string, dir: Readonly<Vec3>, track: TrackAxis, up: UpAxis, fallbackUp: Readonly<Vec3>): boolean {
    const rot = trackRotation(dir, track, up, [0, 0, 1], fallbackUp);
    if (!rot) return false;
    const stored = this.ctx.doc.getObject(id);
    const o = this.editedIds.has(id) ? stored : this.ev.byId.get(id)?.data;
    if (!o || !stored) return true;
    const toParent = this.hasParent(id) ? invertSafe(linearPart(this.parentWorld(id))) : identity4();
    const ti = AXIS_INDEX[track.slice(-1) as UpAxis];
    const ui = AXIS_INDEX[up];
    // the object's axes in the parent's space: the world axis of a negative scale points the other way
    const local = (k: number) => {
      const v = transformDirection3(toParent, [rot[k * 4], rot[k * 4 + 1], rot[k * 4 + 2]]);
      return o.scale[k] < 0 ? ([-v[0], -v[1], -v[2]] as Vec3) : v;
    };
    const cols: Vec3[] = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const t = normalize3(local(ti));
    const u0 = local(ui);
    const along = dot3(u0, t);
    const u = normalize3([u0[0] - t[0] * along, u0[1] - t[1] * along, u0[2] - t[2] * along]);
    if (length3(t) === 0 || length3(u) === 0) return true;
    cols[ti] = t;
    cols[ui] = u;
    const k = 3 - ti - ui;
    cols[k] = cross3(cols[(k + 1) % 3], cols[(k + 2) % 3]);
    const rotation = matrixToStoredEuler(matrixFromAxes(cols[0], cols[1], cols[2]), o.rotation_euler);
    const next = { location: o.location, rotation_euler: rotation, scale: o.scale };
    this.writeChannels(id, o, next, transformTolerance(this.basis(id, o)));
    return true;
  }

  /** Records an edit made directly to an object's transform fields (for keying). */
  touch(id: string): void {
    this.editedIds.add(id);
  }

  /**
   * Object-space points describing the object's geometry: its evaluated mesh, curve wire, or the
   * geometry of the collection it instances. Null for objects without geometry.
   */
  localPoints(id: string): ArrayLike<number> | null {
    if (this.pointCache.has(id)) return this.pointCache.get(id)!;
    const o = this.get(id);
    let pts: ArrayLike<number> | null = null;
    if (o.mesh && o.mesh.positions.length >= 3) pts = o.mesh.positions;
    else if (o.lines && o.lines.length >= 3) pts = o.lines;
    else if (o.type === 'EMPTY' && o.data.instance_type === 'COLLECTION') {
      const inv = invert4(o.worldMatrix);
      const out: number[] = [];
      for (const inst of this.ev.instances) {
        if (inst.ownerId !== id) continue;
        const src = this.ev.byId.get(inst.sourceId);
        const P = src?.mesh?.positions;
        if (!P) continue;
        const m = multiply4(inv, inst.matrix);
        if (P.length > 300_000) {
          // very large sources: their bounding box corners are enough for a box
          const b = pointsBounds(P);
          if (isEmptyBounds(b)) continue;
          for (let c = 0; c < 8; c++)
            out.push(
              ...transformPoint3(m, [
                c & 1 ? b.max[0] : b.min[0],
                c & 2 ? b.max[1] : b.min[1],
                c & 4 ? b.max[2] : b.min[2],
              ]),
            );
        } else
          for (let i = 0; i + 2 < P.length; i += 3)
            out.push(...transformPoint3(m, [P[i], P[i + 1], P[i + 2]]));
      }
      if (out.length >= 3) pts = out;
    }
    this.pointCache.set(id, pts);
    return pts;
  }

  hasGeometry(id: string): boolean {
    return this.localPoints(id) !== null;
  }

  /** World-space bounds of the object's geometry, or of its origin when it has none. */
  bounds(id: string): Bounds {
    const w = this.world(id);
    const pts = this.localPoints(id);
    if (pts) {
      const b = pointsBounds(pts, w);
      if (!isEmptyBounds(b)) return b;
    }
    const o = translationOf(w);
    return { min: [...o], max: [...o] };
  }

  /** Object-space bounds of the geometry (Blender bound_box), or null without geometry. */
  localBounds(id: string): Bounds | null {
    const pts = this.localPoints(id);
    if (!pts) return null;
    const b = pointsBounds(pts);
    return isEmptyBounds(b) ? null : b;
  }

  /** Geometry of an object as ray cast targets in its current world placement. */
  geometryTargets(id: string, world?: Mat4): RaycastTarget[] {
    const o = this.get(id);
    const w = world ?? this.world(id);
    if (o.mesh) return [{ id, objectId: id, instancer: null, mesh: o.mesh, matrix: w }];
    if (o.type === 'EMPTY' && o.data.instance_type === 'COLLECTION') {
      const rel = multiply4(w, invert4(o.worldMatrix));
      const out: RaycastTarget[] = [];
      for (const inst of this.ev.instances) {
        if (inst.ownerId !== id) continue;
        const src = this.ev.byId.get(inst.sourceId);
        if (src?.mesh)
          out.push({
            id: inst.id,
            objectId: inst.sourceId,
            instancer: id,
            mesh: src.mesh,
            matrix: multiply4(rel, inst.matrix),
          });
      }
      return out;
    }
    return [];
  }

  /** The ids and all their descendants. */
  withDescendants(ids: Iterable<string>): Set<string> {
    const set = new Set(ids);
    for (const o of this.ev.objects) if (this.ancestors(o.id).some((a) => set.has(a))) set.add(o.id);
    return set;
  }

  /**
   * Visible geometry as ray cast targets (mesh, curve and text objects; optionally instances),
   * excluding `exclude` (and the instances they own or are the source of), restricted to `only`
   * when given.
   */
  targets(
    opts: { exclude?: Set<string>; only?: Set<string> | null; instances?: boolean } = {},
  ): RaycastTarget[] {
    const out: RaycastTarget[] = [];
    const ex = opts.exclude ?? new Set<string>();
    for (const o of this.ev.objects) {
      if (!o.mesh || ex.has(o.id)) continue;
      if (opts.only ? !opts.only.has(o.id) : !o.visible) continue;
      out.push({ id: o.id, objectId: o.id, instancer: null, mesh: o.mesh, matrix: this.world(o.id) });
    }
    if (opts.instances)
      for (const inst of this.ev.instances) {
        const owner = this.ev.byId.get(inst.ownerId);
        const src = this.ev.byId.get(inst.sourceId);
        if (!owner || !src?.mesh || ex.has(owner.id) || ex.has(src.id)) continue;
        if (opts.only ? !opts.only.has(owner.id) && !opts.only.has(src.id) : !owner.visible) continue;
        out.push({ id: inst.id, objectId: src.id, instancer: owner.id, mesh: src.mesh, matrix: inst.matrix });
      }
    return out;
  }

  /** Keys the edited objects like the transform operators; returns their ids. */
  commit(): string[] {
    const ids = [...this.editedIds].filter((id) => this.ctx.doc.getObject(id));
    if (this.ctx.state.autoKeying) autoKeyTransforms(this.ctx, ids);
    else for (const id of ids) rekeyAnimated(this.ctx, 'object', id, ['location', 'rotation_euler', 'scale']);
    return ids;
  }
}

function nameOf(ctx: OperatorContext, id: string | null): string | null {
  return id ? (ctx.doc.getObject(id)?.name ?? null) : null;
}

function requireObjects(ctx: OperatorContext, refs: string[] | undefined, what = 'objects'): string[] {
  const ids = [...new Set(resolveObjectIds(ctx, refs))];
  if (ids.length === 0) throw new OperatorError(`No ${what} given or selected`, 'POLL_FAILED');
  return ids;
}

function resolveOne(ctx: OperatorContext, ref: string): ObjectData {
  const o = ctx.doc.resolveObject(ref);
  if (!o) throw new OperatorError(`Object '${ref}' not found`, 'NOT_FOUND');
  return o;
}

function hitInfo(ctx: OperatorContext, hit: SceneHit) {
  return {
    object: hit.target.objectId,
    name: nameOf(ctx, hit.target.objectId),
    instancer: hit.target.instancer,
    point: r3(hit.point),
    normal: r3(hit.normal),
    distance: round(hit.distance),
    face: hit.face,
    front: hit.front,
  };
}

// ------------------------------------------------------------------ object creation (bulk)

/**
 * Unique Blender-style names ("Tree", "Tree.001", …) for many new datablocks of one kind, without
 * rescanning the document for every name.
 */
function blockNamer(doc: SceneDoc, kind: DatablockKind): (base: string) => string {
  const taken = new Set<string>();
  for (const y of doc.map(kind).values()) taken.add(String((y as Y.Map<unknown>).get('name') ?? ''));
  const next = new Map<string, number>();
  return (base) => {
    const clean = (base || 'Object').trim() || 'Object';
    if (!taken.has(clean)) {
      taken.add(clean);
      return clean;
    }
    const stem = clean.replace(/\.\d{3,}$/, '');
    let i = next.get(stem) ?? 1;
    let name = `${stem}.${String(i).padStart(3, '0')}`;
    while (taken.has(name)) name = `${stem}.${String(++i).padStart(3, '0')}`;
    next.set(stem, i + 1);
    taken.add(name);
    return name;
  };
}

/** Adds objects (one Yjs map each) in the current transaction. */
function addObjects(
  doc: SceneDoc,
  inits: (Partial<ObjectData> & { type: ObjectType; name: string })[],
): string[] {
  const unique = blockNamer(doc, 'objects');
  const map = doc.map('objects');
  const ids: string[] = [];
  doc.transact(() => {
    for (const init of inits) {
      const id = newId();
      const fields: Record<string, unknown> = { ...defaultObject(init.type, id, init.name), ...init };
      fields.name = unique(init.name);
      const y = new Y.Map<unknown>();
      map.set(id, y);
      y.set('id', id);
      for (const [k, v] of Object.entries(fields)) {
        if (k === 'id' || v === undefined) continue;
        y.set(k, v instanceof Uint8Array ? v : cloneJson(v));
      }
      ids.push(id);
    }
  });
  return ids;
}

/** Most bytes of object data (meshes, curves, …) one array_place / scatter_on_surface run may copy. */
export const MAX_COPY_BYTES = 64 * 1024 * 1024;

/**
 * Independent copies of object data blocks for many new objects (non-linked duplicates). Each
 * source block is read once: a mesh's encoded geometry is shared by all of its copies instead of
 * being decoded and re-encoded per copy, and names are made unique without rescanning the document
 * per copy, so n copies cost O(n).
 */
class DataCopier {
  private readonly sources = new Map<
    string,
    { kind: DatablockKind; name: string; fields: [string, unknown][]; bytes: number } | null
  >();
  private readonly namers = new Map<DatablockKind, (base: string) => string>();

  constructor(private readonly doc: SceneDoc) {}

  /** Approximate stored size in bytes of one copy of the object's data (0 when it has none). */
  size(o: ObjectData): number {
    return this.source(o)?.bytes ?? 0;
  }

  /** Id of a new copy of the object's data block (the object's own data id when there is none). */
  copy(o: ObjectData): string | null {
    const src = this.source(o);
    if (!src) return o.data;
    let namer = this.namers.get(src.kind);
    if (!namer) this.namers.set(src.kind, (namer = blockNamer(this.doc, src.kind)));
    const id = newId();
    const y = new Y.Map<unknown>();
    this.doc.map(src.kind).set(id, y);
    y.set('id', id);
    y.set('name', namer(src.name));
    for (const [k, v] of src.fields) y.set(k, v instanceof Uint8Array ? v : cloneJson(v));
    return id;
  }

  private source(o: ObjectData) {
    if (!o.data) return null;
    let s = this.sources.get(o.data);
    if (s === undefined) {
      const kind = dataKindOf(o.type);
      const y = kind ? (this.doc.map(kind).get(o.data) as Y.Map<unknown> | undefined) : undefined;
      s = null;
      if (kind && y) {
        const fields: [string, unknown][] = [];
        let bytes = 64;
        for (const [k, v] of y.entries()) {
          if (k === 'id' || k === 'name') continue;
          fields.push([k, v]);
          bytes += v instanceof Uint8Array ? v.byteLength : JSON.stringify(v ?? null).length;
        }
        s = { kind, name: String(y.get('name') ?? o.name), fields, bytes };
      }
      this.sources.set(o.data, s);
    }
    return s;
  }
}

/** Fails (before anything is created) when the planned data copies total more than MAX_COPY_BYTES. */
function checkCopyBudget(bytes: number): void {
  if (bytes > MAX_COPY_BYTES)
    throw new OperatorError(
      `Independent copies would duplicate ${(bytes / 2 ** 20).toFixed(1)} MB of object data (limit ` +
        `${MAX_COPY_BYTES / 2 ** 20} MB): use linked=true (copies share the data) or fewer copies`,
      'INVALID_PARAMS',
    );
}

/**
 * Location / rotation / scale of a new object with the given parent-relative matrix, as close as
 * possible to the values of the object it copies (compatible eulers, same scale signs).
 */
function transformFields(local: Mat4, like: Pick<ObjectData, 'rotation_euler' | 'scale'>) {
  const d = decomposeCompatible(local, like.rotation_euler, like.scale);
  const r = d ?? decompose4(local);
  return { location: clean3(r.location), rotation_euler: clean3(r.rotation), scale: clean3(r.scale) };
}

/** Fields of a duplicate of `o` (modifiers, constraints and particle systems get fresh ids). */
function duplicateFields(o: ObjectData): Partial<ObjectData> & { type: ObjectType; name: string } {
  const { id: _id, ...rest } = cloneJson(o);
  return {
    ...rest,
    modifiers: rest.modifiers.map((m) => ({ ...m, id: newId() })),
    constraints: rest.constraints.map((c) => ({ ...c, id: newId() })),
    particle_systems: rest.particle_systems.map((s) => ({ ...s, id: newId() })),
  };
}

// ------------------------------------------------------------------ operators

export function registerSceneToolsOperators(reg: OperatorRegistry): void {
  // ------------------------------------------------------------------ align
  reg.register(
    defineOperator({
      id: 'object.align',
      label: 'Align Objects',
      description:
        'Align objects along world axes (Blender Object > Transform > Align Objects): for every axis in `axis`, ' +
        'each object moves so that the MIN side, CENTER or MAX side of its world bounding box (evaluated geometry; ' +
        'the origin for objects without geometry) lines up with the reference: WORLD = the scene origin (0), ' +
        'CURSOR = the 3D cursor, SELECTION = the same side of the bounding box around all the objects, ACTIVE = ' +
        'the same side of the active object (which stays put). Only translates. Returns per object the applied ' +
        'world offset and the new world origin.',
      category: 'Layout',
      redoable: true,
      schema: z.object({
        objects: objectsParam,
        axis: z
          .array(z.enum(AXES))
          .min(1)
          .default(['X'])
          .describe('World axes to align along, e.g. ["X"] or ["X", "Y"]'),
        mode: z
          .enum(['MIN', 'CENTER', 'MAX'])
          .default('CENTER')
          .describe(
            'Which part of each bounding box is aligned: MIN (negative) side, CENTER or MAX (positive) side',
          ),
        relative_to: z
          .enum(['WORLD', 'CURSOR', 'SELECTION', 'ACTIVE'])
          .default('ACTIVE')
          .describe('Reference to align to (see the operator description)'),
        active: z
          .string()
          .optional()
          .describe('relative_to ACTIVE: reference object by id or name (default: the active object)'),
        use_bounds: z
          .boolean()
          .default(true)
          .describe('true: align world bounding boxes of the geometry; false: align the object origins'),
      }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const ids = requireObjects(ctx, p.objects);
        const scene = new LayoutScene(ctx);
        const box = (id: string): Bounds => {
          if (p.use_bounds) return scene.bounds(id);
          const o = translationOf(scene.world(id));
          return { min: o, max: [...o] };
        };
        const axes = [...new Set(p.axis)].map((a) => AXIS_INDEX[a]);
        const mode = p.mode as AlignMode;
        let reference: (axis: number) => number;
        if (p.relative_to === 'WORLD') reference = () => 0;
        else if (p.relative_to === 'CURSOR') reference = (k) => ctx.state.cursorLocation[k];
        else if (p.relative_to === 'SELECTION') {
          const all = ids.map(box).reduce(unionBounds);
          reference = (k) => boundsValue(all, k, mode);
        } else {
          const ref = p.active ? resolveOne(ctx, p.active).id : ctx.state.activeId;
          if (!ref || !ctx.doc.getObject(ref))
            throw new OperatorError('relative_to ACTIVE needs an active object (or `active`)', 'POLL_FAILED');
          const b = box(ref);
          reference = (k) => boundsValue(b, k, mode);
        }
        const targets = axes.map((k) => reference(k));
        const out = [];
        for (const id of scene.byDepth(ids)) {
          const b = box(id);
          const delta: Vec3 = [0, 0, 0];
          axes.forEach((k, i) => (delta[k] = targets[i] - boundsValue(b, k, mode)));
          scene.translate(id, delta);
          out.push({
            object: id,
            name: nameOf(ctx, id),
            delta: r3(delta),
            location: r3(translationOf(scene.world(id))),
          });
        }
        scene.commit();
        return { objects: out };
      },
    }),
  );

  // ------------------------------------------------------------------ distribute
  reg.register(
    defineOperator({
      id: 'object.distribute',
      label: 'Distribute Objects',
      description:
        'Distribute 2+ objects along a world axis, ordered by their current position along it. EVEN keeps the first ' +
        'and the last object in place and moves the others so the gaps between neighbouring bounding boxes are ' +
        'equal (use_bounds=false: equal origin-to-origin distances); GAP keeps the first object and places each ' +
        'next one exactly `gap` metres after the previous one (bounding box to bounding box, or origin to origin). ' +
        'Only translates along the axis. Returns the objects in order with their offsets, and the resulting gap.',
      category: 'Layout',
      redoable: true,
      schema: z.object({
        objects: objectsParam,
        axis: z.enum(AXES).default('X').describe('World axis to distribute along'),
        mode: z
          .enum(['EVEN', 'GAP'])
          .default('EVEN')
          .describe('EVEN: evenly between the extremes; GAP: fixed gap'),
        gap: z
          .number()
          .min(-1e6)
          .max(1e6)
          .default(0)
          .describe('GAP mode: metres between consecutive bounding boxes (or origins when use_bounds=false)'),
        use_bounds: z
          .boolean()
          .default(true)
          .describe('true: space the world bounding boxes of the geometry; false: space the object origins'),
      }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const ids = requireObjects(ctx, p.objects);
        if (ids.length < 2) throw new OperatorError('Distribute needs at least two objects', 'POLL_FAILED');
        const scene = new LayoutScene(ctx);
        const k = AXIS_INDEX[p.axis];
        const extent = (id: string) => {
          if (p.use_bounds) {
            const b = scene.bounds(id);
            return { lo: b.min[k], hi: b.max[k] };
          }
          const o = scene.world(id)[12 + k];
          return { lo: o, hi: o };
        };
        const items = ids.map(extent);
        const res = distributeDeltas(items, p.mode, p.gap);
        const wanted = new Map(ids.map((id, i) => [id, items[i].lo + res.deltas[i]]));
        const applied = new Map<string, number>();
        for (const id of scene.byDepth(ids)) {
          // ancestors moved earlier in this run already carried this object along
          const d = wanted.get(id)! - extent(id).lo;
          const delta: Vec3 = [0, 0, 0];
          delta[k] = d;
          scene.translate(id, delta);
          applied.set(id, d);
        }
        scene.commit();
        return {
          axis: p.axis,
          gap: round(res.gap),
          objects: res.order.map((i) => ({
            object: ids[i],
            name: nameOf(ctx, ids[i]),
            offset: round(applied.get(ids[i]) ?? 0),
            location: r3(translationOf(scene.world(ids[i]))),
          })),
        };
      },
    }),
  );

  // ------------------------------------------------------------------ drop to ground
  reg.register(
    defineOperator({
      id: 'object.drop_to_ground',
      label: 'Drop to Ground',
      description:
        'Move objects straight down (or up, out of a surface they are sunk into or buried under) until their ' +
        'lowest geometry rests on the surface below: other visible mesh, curve and text objects and their ' +
        'instances (collection instances, particles), or only `surface`, using the evaluated world-space ' +
        'geometry of both (rays from every vertex down onto the surfaces and from the surface vertices under the ' +
        'object up onto it). The supporting surface is the first one below the top of the object whose outside ' +
        'faces up, so surfaces above the object (a table top over a stool) are ignored, except where the object ' +
        'is under a surface that faces up with nothing below it (buried under a terrain, inside a rock): there it ' +
        'is lifted onto that surface, e.g. objects generated at z = 0 under a terrain. Where no surface is below ' +
        'or above, the plane z = 0 is the ground (ground_plane; it lifts objects below it too). ' +
        'align_to_normal first tilts the object so its local +Z follows the surface normal under its centre. ' +
        'Objects are dropped independently (never onto each other). A parent drops together with its children ' +
        '(e.g. an empty grouping the parts of a lamp post rests on the lowest point of the whole assembly, so ' +
        'no part ends up buried); objects given together with one of their ancestors move along with it ' +
        '(moved_with). Returns per object whether it was dropped, the vertical move (metres), the contact point ' +
        'on the surface, its normal, the surface name (or "ground plane"), the new world origin and the ' +
        'children whose geometry counted.',
      category: 'Layout',
      redoable: true,
      schema: z.object({
        objects: objectsParam,
        surface: z
          .array(z.string())
          .optional()
          .describe(
            'Surface objects to drop onto, by id or name, including the instances they own or are the source ' +
              'of (default: every other visible geometry object and instance; restrict it when geometry ' +
              'encloses the scene, e.g. a sky dome, which would otherwise count as a solid the objects are in)',
          ),
        include_instances: z
          .boolean()
          .default(true)
          .describe(
            'Also rest on collection-instance and particle instances (false: e.g. ignore scattered grass)',
          ),
        ground_plane: z
          .boolean()
          .default(true)
          .describe(
            'Where no surface is below (or above) the object, use the infinite plane z = 0 as the ground ' +
              '(objects below it are lifted onto it)',
          ),
        align_to_normal: z
          .boolean()
          .default(false)
          .describe('Rotate the object (about its origin) so its local +Z axis follows the surface normal'),
        offset: z
          .number()
          .min(-1e4)
          .max(1e4)
          .default(0)
          .describe('Extra height above the surface in metres (negative sinks the object in)'),
        use_origin: z
          .boolean()
          .default(false)
          .describe('Put the object origin on the surface instead of its lowest geometry'),
      }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const ids = requireObjects(ctx, p.objects);
        const scene = new LayoutScene(ctx);
        const moving = scene.withDescendants(ids);
        const only = p.surface?.length ? new Set(p.surface.map((r) => resolveOne(ctx, r).id)) : null;
        const targets = new SceneRaycaster(
          scene.targets({ exclude: moving, only, instances: p.include_instances }),
        );
        // A parent carries its children: each object drops as an assembly with its (visible)
        // descendants, and objects given together with an ancestor move along with it.
        const given = new Set(ids);
        const roots = ids.filter((id) => !scene.ancestors(id).some((a) => given.has(a)));
        const out: Record<string, unknown>[] = [];
        const moves = new Map<string, number>();
        for (const id of scene.byDepth(roots)) {
          let world = scene.world(id);
          const origin = translationOf(world);
          const inverse = invert4(world);
          // the object itself and its visible descendants with geometry, relative to the object
          const members = [...scene.withDescendants([id])]
            .filter((m) => (m === id || scene.get(m).visible) && scene.hasGeometry(m))
            .map((m) => ({ id: m, rel: m === id ? identity4() : multiply4(inverse, scene.world(m)) }));
          const pointsOf = (w: Mat4): ArrayLike<number> => {
            if (p.use_origin || !members.length) return translationOf(w);
            const all: number[] = [];
            for (const m of members) {
              const pts = scene.localPoints(m.id)!;
              const mw = m.id === id ? w : multiply4(w, m.rel);
              for (let i = 0; i + 2 < pts.length; i += 3)
                all.push(...transformPoint3(mw, [pts[i], pts[i + 1], pts[i + 2]]));
            }
            return all.length ? all : translationOf(w);
          };
          if (p.align_to_normal) {
            const b = pointsBounds(pointsOf(world));
            const c = p.use_origin ? origin : boundsCenter(b);
            const probe = computeDrop(
              [c[0], c[1], isEmptyBounds(b) ? c[2] : b.max[2]],
              null,
              targets,
              p.ground_plane,
            );
            if (probe) {
              // turned about its origin as Blender's Rotate turns it (only the rotation changes)
              scene.turn(id, rotationBetween(axisOf(world, 2), probe.normal), origin);
              world = scene.world(id);
            }
          }
          const pts = pointsOf(world);
          const geometry =
            p.use_origin || !members.length
              ? null
              : new SceneRaycaster(
                  members.flatMap((m) =>
                    scene.geometryTargets(m.id, m.id === id ? world : multiply4(world, m.rel)),
                  ),
                );
          const children = members.filter((m) => m.id !== id).map((m) => nameOf(ctx, m.id));
          const drop = computeDrop(pts, geometry, targets, p.ground_plane);
          if (!drop) {
            ctx.report('WARNING', `Nothing below '${nameOf(ctx, id)}' to drop onto`);
            out.push({ object: id, name: nameOf(ctx, id), dropped: false });
            continue;
          }
          const dz = drop.dz + p.offset;
          scene.translate(id, [0, 0, dz]);
          moves.set(id, dz);
          out.push({
            object: id,
            name: nameOf(ctx, id),
            dropped: true,
            moved: round(dz),
            contact: r3(drop.point),
            normal: r3(drop.normal),
            surface: drop.target ? nameOf(ctx, drop.target.objectId) : 'ground plane',
            location: r3(translationOf(scene.world(id))),
            ...(children.length && !p.use_origin ? { children } : {}),
          });
        }
        // objects given together with an ancestor moved along with it
        for (const id of ids) {
          if (roots.includes(id)) continue;
          const root = scene.ancestors(id).find((a) => roots.includes(a))!;
          out.push({
            object: id,
            name: nameOf(ctx, id),
            dropped: moves.has(root),
            moved_with: nameOf(ctx, root),
            location: r3(translationOf(scene.world(id))),
          });
        }
        scene.commit();
        return { objects: out };
      },
    }),
  );

  // ------------------------------------------------------------------ snap to surface
  reg.register(
    defineOperator({
      id: 'object.snap_to_surface',
      label: 'Snap to Surface',
      description:
        'Cast a ray (world space) against the visible geometry including instances (collection instances, ' +
        'particles), or only `surface`, and place the objects at the ' +
        'hit: the snap point of the reference object (the active one if it is among `objects`, else the first) ' +
        'lands on the hit point plus `offset` along the surface normal, and the other objects move along, keeping ' +
        "their arrangement. align_to_normal also rotates the group so the reference object's local +Z follows " +
        'the normal (facing the ray origin). Fails without changes when the ray hits nothing. Returns the hit ' +
        '(object, point, normal, distance, face) and the new object locations.',
      category: 'Layout',
      redoable: true,
      schema: z.object({
        objects: objectsParam,
        ray_origin: vec3.describe('World-space start of the ray in metres'),
        ray_direction: vec3
          .default([0, 0, -1])
          .describe('Ray direction (normalized internally; default straight down)'),
        max_distance: z
          .number()
          .positive()
          .max(1e9)
          .default(1e6)
          .describe('Maximum hit distance from the ray origin in metres'),
        surface: z
          .array(z.string())
          .optional()
          .describe(
            'Objects the ray may hit, by id or name, including the instances they own or are the source of ' +
              '(default: every visible geometry object and instance except the moved ones)',
          ),
        include_instances: z
          .boolean()
          .default(true)
          .describe('Also hit collection-instance and particle instances'),
        align_to_normal: z
          .boolean()
          .default(false)
          .describe("Rotate so the reference object's local +Z axis follows the surface normal"),
        offset: z
          .number()
          .min(-1e4)
          .max(1e4)
          .default(0)
          .describe('Distance from the surface along its normal in metres'),
        snap_point: z
          .enum(['ORIGIN', 'BOTTOM'])
          .default('ORIGIN')
          .describe(
            'Point of the reference object put on the hit: its ORIGIN, or BOTTOM = the centre of the underside of its local bounding box',
          ),
      }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const ids = requireObjects(ctx, p.objects);
        if (!(Math.hypot(...p.ray_direction) > 0))
          throw new OperatorError('ray_direction must not be zero', 'INVALID_PARAMS');
        const scene = new LayoutScene(ctx);
        const moving = scene.withDescendants(ids);
        const only = p.surface?.length ? new Set(p.surface.map((r) => resolveOne(ctx, r).id)) : null;
        const rc = new SceneRaycaster(
          scene.targets({ exclude: moving, only, instances: p.include_instances }),
        );
        const hit = rc.cast(p.ray_origin as Vec3, p.ray_direction as Vec3, p.max_distance);
        if (!hit) throw new OperatorError('The ray hit no surface', 'FAILED');
        const dir = p.ray_direction as Vec3;
        const n: Vec3 =
          hit.normal[0] * dir[0] + hit.normal[1] * dir[1] + hit.normal[2] * dir[2] > 0
            ? [-hit.normal[0], -hit.normal[1], -hit.normal[2]]
            : hit.normal;
        const ref = ctx.state.activeId && ids.includes(ctx.state.activeId) ? ctx.state.activeId : ids[0];
        const wRef = scene.world(ref);
        let snapLocal: Vec3 = [0, 0, 0];
        if (p.snap_point === 'BOTTOM') {
          const lb = scene.localBounds(ref);
          if (lb) snapLocal = [(lb.min[0] + lb.max[0]) / 2, (lb.min[1] + lb.max[1]) / 2, lb.min[2]];
        }
        const s = transformPoint3(wRef, snapLocal);
        const target: Vec3 = [
          hit.point[0] + n[0] * p.offset,
          hit.point[1] + n[1] * p.offset,
          hit.point[2] + n[2] * p.offset,
        ];
        const roots = ids.filter((id) => !scene.ancestors(id).some((a) => ids.includes(a)));
        if (p.align_to_normal) {
          // the group turns about the snap point, as Blender's Rotate turns each object, and moves it
          // onto the target
          const r = rotationBetween(axisOf(wRef, 2), n);
          const offset: Vec3 = [target[0] - s[0], target[1] - s[1], target[2] - s[2]];
          for (const id of scene.byDepth(roots)) scene.turn(id, r, s, offset);
        } else {
          const delta: Vec3 = [target[0] - s[0], target[1] - s[1], target[2] - s[2]];
          for (const id of scene.byDepth(roots)) scene.translate(id, delta);
        }
        scene.commit();
        return {
          hit: hitInfo(ctx, hit),
          objects: ids.map((id) => ({
            object: id,
            name: nameOf(ctx, id),
            location: r3(translationOf(scene.world(id))),
          })),
        };
      },
    }),
  );

  // ------------------------------------------------------------------ look at
  reg.register(
    defineOperator({
      id: 'object.look_at',
      label: 'Look At',
      description:
        "Rotate objects so one of their axes points at a target object's world origin or a world point (a one-off " +
        'Track To): `track_axis` (default −Z, the viewing direction of cameras and lights) points at the target ' +
        'and `up_axis` points as close as possible to world +Z. Positions and scales are kept. Returns the new ' +
        'rotation_euler of every object.',
      category: 'Layout',
      redoable: true,
      schema: z.object({
        objects: objectsParam,
        target: z.string().optional().describe('Object to look at, by id or name (its world origin)'),
        point: vec3.optional().describe('World point to look at in metres (used when `target` is not given)'),
        track_axis: z
          .enum(['-Z', 'Z', '-Y', 'Y', '-X', 'X'])
          .default('-Z')
          .describe('Object axis that points at the target ("-Z" for cameras and lights)'),
        up_axis: z
          .enum(['AUTO', 'X', 'Y', 'Z'])
          .default('AUTO')
          .describe('Object axis that points up (towards world +Z); AUTO = Y when tracking ±Z, otherwise Z'),
      }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const ids = requireObjects(ctx, p.objects);
        const scene = new LayoutScene(ctx);
        let targetId: string | null = null;
        if (p.target) targetId = resolveOne(ctx, p.target).id;
        else if (!p.point)
          throw new OperatorError('Give a `target` object or a `point` to look at', 'INVALID_PARAMS');
        const track = p.track_axis as TrackAxis;
        const up: UpAxis = p.up_axis === 'AUTO' ? (track.endsWith('Z') ? 'Y' : 'Z') : p.up_axis;
        if (track.endsWith(up))
          throw new OperatorError('track_axis and up_axis must be different axes', 'INVALID_PARAMS');
        const out = [];
        for (const id of scene.byDepth(ids)) {
          if (id === targetId) continue;
          const w = scene.world(id);
          const pos = translationOf(w);
          const goal = targetId ? translationOf(scene.world(targetId)) : (p.point as Vec3);
          const dir: Vec3 = [goal[0] - pos[0], goal[1] - pos[1], goal[2] - pos[2]];
          if (!scene.aim(id, dir, track, up, axisOf(w, AXIS_INDEX[up]))) {
            ctx.report('WARNING', `'${nameOf(ctx, id)}' is at the target point; not rotated`);
            continue;
          }
          out.push({
            object: id,
            name: nameOf(ctx, id),
            rotation_euler: r3(ctx.doc.getObject(id)!.rotation_euler),
          });
        }
        scene.commit();
        return { objects: out };
      },
    }),
  );

  // ------------------------------------------------------------------ randomize transform
  reg.register(
    defineOperator({
      id: 'object.randomize_transform',
      label: 'Randomize Transform',
      description:
        "Randomize the objects' location, rotation and scale (Blender object.randomize_transform, same parameters " +
        'and formulas, deterministic for a random_seed): location += uniform(−loc, +loc) per axis (metres, in the ' +
        'parent space like the location field); rotation_euler += uniform(−rot, +rot) per axis (radians); ' +
        'scale = scale × (1 − u) with u = uniform(−scale, +scale) per axis (or one u for all axes with ' +
        'scale_even). NOTE the Blender defaults: use_scale is on with scale [1, 1, 1], which randomizes each ' +
        'scale between 0× and 2×; pass use_scale=false (or smaller values such as [0.2, 0.2, 0.2]) to keep sizes ' +
        'sensible. Returns the new transform of every object.',
      category: 'Layout',
      redoable: true,
      schema: z.object({
        objects: objectsParam,
        random_seed: z
          .number()
          .int()
          .min(0)
          .max(10000)
          .default(0)
          .describe('Seed of the random generator (same seed = same result)'),
        use_loc: z.boolean().default(true).describe('Randomize the location'),
        loc: z
          .tuple([
            z.number().min(-100).max(100),
            z.number().min(-100).max(100),
            z.number().min(-100).max(100),
          ])
          .default([0, 0, 0])
          .describe('Maximum location change per axis in metres'),
        use_rot: z.boolean().default(true).describe('Randomize the rotation'),
        rot: z
          .tuple([
            z.number().min(-Math.PI).max(Math.PI),
            z.number().min(-Math.PI).max(Math.PI),
            z.number().min(-Math.PI).max(Math.PI),
          ])
          .default([0, 0, 0])
          .describe('Maximum rotation change per axis in radians'),
        use_scale: z.boolean().default(true).describe('Randomize the scale'),
        scale_even: z
          .boolean()
          .default(false)
          .describe('Use the same random scale factor for all three axes'),
        scale: z
          .tuple([
            z.number().min(-100).max(100),
            z.number().min(-100).max(100),
            z.number().min(-100).max(100),
          ])
          .default([1, 1, 1])
          .describe('Maximum relative scale change per axis (scale_even uses the first value)'),
      }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const ids = requireObjects(ctx, p.objects);
        const rng = new Rng(p.random_seed, 0x7a4d);
        // start from the animated values at the current frame (what the user sees)
        const fs = new FrameState(ctx.doc, ctx.state.frame);
        const out = [];
        const touched: string[] = [];
        for (const id of ids) {
          const o = fs.byId.get(id) ?? ctx.doc.getObject(id)!;
          // always draw nine numbers so toggling one channel does not reshuffle the others
          const l = [rng.spread(1), rng.spread(1), rng.spread(1)];
          const r = [rng.spread(1), rng.spread(1), rng.spread(1)];
          const s = [rng.spread(1), rng.spread(1), rng.spread(1)];
          const location = o.location.map((v, k) => (p.use_loc ? v + l[k] * p.loc[k] : v)) as Vec3;
          const rotation = o.rotation_euler.map((v, k) => (p.use_rot ? v + r[k] * p.rot[k] : v)) as Vec3;
          const scale = o.scale.map((v, k) => {
            if (!p.use_scale) return v;
            const u = p.scale_even ? s[0] * p.scale[0] : s[k] * p.scale[k];
            return v * (1 - u);
          }) as Vec3;
          ctx.doc.updateObject(id, {
            location: clean3(location),
            rotation_euler: clean3(rotation),
            scale: clean3(scale),
          });
          touched.push(id);
          out.push({
            object: id,
            name: o.name,
            location: r3(location),
            rotation_euler: r3(rotation),
            scale: r3(scale),
          });
        }
        if (ctx.state.autoKeying) autoKeyTransforms(ctx, touched);
        else
          for (const id of touched) rekeyAnimated(ctx, 'object', id, ['location', 'rotation_euler', 'scale']);
        return { objects: out };
      },
    }),
  );

  // ------------------------------------------------------------------ array placement
  reg.register(
    defineOperator({
      id: 'object.array_place',
      label: 'Array Place',
      description:
        'Duplicate the objects (as one group) into a regular arrangement; the originals are the first item. ' +
        'LINE: `count` items, each `offset` (world metres) after the previous one. GRID: `columns` × `rows` ' +
        'items, `spacing` metres apart along world X (columns) and Y (rows). CIRCLE: `count` items around the ' +
        'vertical axis through `center` (default: `radius` metres along −X from the centre of the group, so the ' +
        'originals stay on the circle), spread over `angle` radians (full circle by default); with rotate=true the ' +
        'copies turn with the circle (e.g. chairs keep facing a round table). linked=true shares the object data ' +
        '(Alt+D, edits apply to all); false makes independent copies (at most ' +
        `${MAX_COPY_BYTES / 2 ** 20} MB of copied data per run). Copies keep parents, collections, materials, ` +
        'modifiers and constraints; inside each copied group, parents, modifier objects (e.g. Armature) and ' +
        'constraint targets point at the copies, like object.duplicate. ' +
        `At most ${MAX_LAYOUT_OBJECTS} new objects. Originals and copies become the ` +
        'selection. Returns the new object ids per item.',
      category: 'Layout',
      redoable: true,
      schema: z.object({
        objects: objectsParam,
        pattern: z.enum(['LINE', 'GRID', 'CIRCLE']).default('LINE').describe('Arrangement'),
        count: z
          .number()
          .int()
          .min(1)
          .max(MAX_LAYOUT_OBJECTS)
          .default(5)
          .describe('LINE / CIRCLE: number of items including the originals'),
        offset: vec3.default([2, 0, 0]).describe('LINE: world-space step from one item to the next, metres'),
        columns: z.number().int().min(1).max(1000).default(3).describe('GRID: items along world X'),
        rows: z.number().int().min(1).max(1000).default(3).describe('GRID: items along world Y'),
        spacing: z
          .tuple([z.number(), z.number()])
          .default([2, 2])
          .describe('GRID: [x, y] distance between columns and between rows, metres'),
        radius: z
          .number()
          .min(0)
          .max(1e6)
          .default(5)
          .describe('CIRCLE without `center`: distance of the circle centre from the group (on −X)'),
        center: vec3
          .optional()
          .describe('CIRCLE: world-space centre of the circle (rotation axis is vertical)'),
        angle: z
          .number()
          .min(-4 * Math.PI)
          .max(4 * Math.PI)
          .default(2 * Math.PI)
          .describe(
            'CIRCLE: arc covered in radians, counter-clockwise seen from above. A full circle (2π, ' +
              `values within ${FULL_TURN_TOLERANCE} of it count, e.g. 6.28) spaces \`count\` items 2π/count ` +
              'apart; a partial arc puts the first and last item at its ends',
          ),
        rotate: z
          .boolean()
          .default(true)
          .describe(
            'CIRCLE: rotate the copies with the circle (false: copies keep the original orientation)',
          ),
        linked: z
          .boolean()
          .default(true)
          .describe(
            `Share the object data between copies (linked duplicates); false copies it (at most ${MAX_COPY_BYTES / 2 ** 20} MB per run)`,
          ),
      }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const ids = requireObjects(ctx, p.objects);
        const scene = new LayoutScene(ctx);
        const items = p.pattern === 'GRID' ? p.columns * p.rows : p.count;
        if ((items - 1) * ids.length > MAX_LAYOUT_OBJECTS)
          throw new OperatorError(
            `${(items - 1) * ids.length} copies exceed the limit of ${MAX_LAYOUT_OBJECTS} objects`,
            'INVALID_PARAMS',
          );
        // item transforms (world space)
        const group = ids.map((id) => scene.bounds(id)).reduce(unionBounds);
        const gc = boundsCenter(group);
        const transforms: Mat4[] = [];
        if (p.pattern === 'LINE') {
          for (let i = 1; i < items; i++)
            transforms.push(translation4([p.offset[0] * i, p.offset[1] * i, p.offset[2] * i]));
        } else if (p.pattern === 'GRID') {
          for (let r = 0; r < p.rows; r++)
            for (let c = 0; c < p.columns; c++)
              if (r || c) transforms.push(translation4([c * p.spacing[0], r * p.spacing[1], 0]));
        } else {
          const c: Vec3 = p.center ? (p.center as Vec3) : [gc[0] - p.radius, gc[1], gc[2]];
          // a full turn (within FULL_TURN_TOLERANCE, e.g. 6.2832 or 6.28) spreads the items evenly
          // without repeating the first one; larger angles wrap around
          const turn = Math.abs(Math.abs(p.angle) - 2 * Math.PI) <= FULL_TURN_TOLERANCE;
          const angle = turn ? Math.sign(p.angle) * 2 * Math.PI : p.angle;
          const full = turn || Math.abs(angle) > 2 * Math.PI;
          const step = full ? angle / items : items > 1 ? angle / (items - 1) : 0;
          for (let i = 1; i < items; i++) {
            const rz = axisAngle4([0, 0, 1], step * i);
            if (p.rotate)
              transforms.push(multiply4(translation4(c), multiply4(rz, translation4([-c[0], -c[1], -c[2]]))));
            else {
              const q = transformPoint3(rz, [gc[0] - c[0], gc[1] - c[1], gc[2] - c[2]]);
              transforms.push(translation4([c[0] + q[0] - gc[0], c[1] + q[1] - gc[1], c[2] + q[2] - gc[2]]));
            }
          }
        }
        const sources = scene.byDepth(ids).map((id) => ctx.doc.getObject(id)!);
        const inGroup = new Set(ids);
        const copier = p.linked ? null : new DataCopier(ctx.doc);
        // objects of the group sharing data share its copy too (like Blender's Shift+D)
        const shared = new Map(sources.filter((o) => o.data).map((o) => [o.data!, o]));
        if (copier)
          checkCopyBudget(transforms.length * [...shared.values()].reduce((n, o) => n + copier.size(o), 0));
        const inits: (Partial<ObjectData> & { type: ObjectType; name: string })[] = [];
        const plan: { item: number; src: ObjectData }[] = [];
        transforms.forEach((m, item) => {
          const dataCopies = new Map<string, string | null>();
          for (const src of sources) {
            const f = duplicateFields(src);
            if (copier && src.data) {
              if (!dataCopies.has(src.data)) dataCopies.set(src.data, copier.copy(src));
              f.data = dataCopies.get(src.data)!;
            } else f.data = src.data;
            if (!(src.parent && inGroup.has(src.parent))) {
              // group roots: new world = item transform · current world, written through the same
              // parent, with eulers continuing the (animated) rotation of the original
              const world = multiply4(m, scene.world(src.id));
              Object.assign(
                f,
                transformFields(multiply4(invert4(scene.parentWorld(src.id)), world), scene.get(src.id).data),
              );
            }
            inits.push(f);
            plan.push({ item, src });
          }
        });
        const created = addObjects(ctx.doc, inits);
        // inside each copied group, parents, modifier objects and constraint targets point at the
        // copies (like object.duplicate)
        const groups = transforms.map(() => new Map<string, string>());
        created.forEach((id, i) => groups[plan[i].item].set(plan[i].src.id, id));
        created.forEach((id, i) => {
          const { item, src } = plan[i];
          if (src.parent && inGroup.has(src.parent))
            ctx.doc.updateObject(id, { parent: groups[item].get(src.parent) ?? src.parent });
        });
        const references = sources.some(
          (o) => o.modifiers.length || o.constraints.length || Object.keys(o.pose?.bones ?? {}).length,
        );
        if (references) for (const map of groups) remapDuplicatedReferences(ctx.doc, map);
        const perItem = groups.map((map) => [...map.values()]);
        setSelection(
          ctx,
          [...ids, ...created],
          ctx.state.activeId && ids.includes(ctx.state.activeId) ? ctx.state.activeId : ids[0],
        );
        ctx.report('INFO', `Placed ${created.length} cop${created.length === 1 ? 'y' : 'ies'}`);
        return { objects: created, items: perItem, count: created.length };
      },
    }),
  );

  // ------------------------------------------------------------------ scatter real copies on a surface
  reg.register(
    defineOperator({
      id: 'object.scatter_on_surface',
      label: 'Scatter on Surface',
      description:
        'Scatter real objects over a surface: `count` copies of `objects` (each copy picks one of them at random) ' +
        "are placed at seeded, area-uniform random points of the surface object's evaluated world-space geometry " +
        '(their origins on the surface), upright (+Z = world up) or along the surface normal (align_to_normal), ' +
        'with random heading, tilt and uniform scale, optionally keeping `min_distance` between them and skipping ' +
        'faces steeper than `max_slope`. The copies are linked duplicates by default (shared data), unparented, in ' +
        "their source's collection; the sources stay where they are. Unlike object.scatter_add (particle " +
        'instances), the copies are ordinary objects you can edit one by one. Deterministic for a seed. The copies ' +
        'become the selection. Returns their ids and how many were placed (fewer than count when min_distance ' +
        'fills the surface).',
      category: 'Layout',
      redoable: true,
      schema: z.object({
        surface: z
          .string()
          .optional()
          .describe('Surface object (mesh, curve or text) by id or name (default: the active object)'),
        objects: z
          .array(z.string())
          .optional()
          .describe('Objects to copy, by id or name (default: the selected objects except the surface)'),
        count: z.number().int().min(1).max(MAX_LAYOUT_OBJECTS).default(20).describe('Number of copies'),
        seed: z.number().int().default(0).describe('Random seed (same seed = same arrangement)'),
        align_to_normal: z
          .boolean()
          .default(false)
          .describe(
            'true: copies follow the surface normal; false: they stay upright (world +Z), e.g. trees',
          ),
        rotation_random: z
          .number()
          .min(0)
          .max(1)
          .default(1)
          .describe('Random spin about the up axis, 0..1 (1 = any heading, 0 = keep the source heading)'),
        tilt_random: z
          .number()
          .min(0)
          .max(Math.PI)
          .default(0)
          .describe('Maximum random tilt away from the up axis in radians'),
        scale_min: z
          .number()
          .positive()
          .max(1000)
          .default(0.8)
          .describe("Smallest random uniform scale factor (relative to the source's scale)"),
        scale_max: z
          .number()
          .positive()
          .max(1000)
          .default(1.2)
          .describe("Largest random uniform scale factor (relative to the source's scale)"),
        min_distance: z
          .number()
          .min(0)
          .max(1e5)
          .default(0)
          .describe('Minimum distance between copies in metres (0 = off)'),
        max_slope: z
          .number()
          .min(0)
          .max(Math.PI)
          .default(Math.PI)
          .describe(
            'Skip faces whose normal deviates more than this angle (radians) from world +Z (π = no limit)',
          ),
        offset: z
          .number()
          .min(-1e4)
          .max(1e4)
          .default(0)
          .describe('Move every copy along its up axis in metres (negative sinks it into the surface)'),
        linked: z
          .boolean()
          .default(true)
          .describe(
            `Share the object data with the source (linked duplicates); false copies it (at most ${MAX_COPY_BYTES / 2 ** 20} MB per run)`,
          ),
      }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const surfRef = p.surface ?? ctx.state.activeId;
        if (!surfRef)
          throw new OperatorError('No surface object given (and no active object)', 'POLL_FAILED');
        const surface = resolveOne(ctx, surfRef);
        const sourceIds = p.objects?.length
          ? [...new Set(p.objects.map((r) => resolveOne(ctx, r).id))]
          : ctx.state.selectedIds.filter((id) => id !== surface.id && ctx.doc.getObject(id));
        const ids = sourceIds.filter((id) => id !== surface.id);
        if (!ids.length)
          throw new OperatorError('No objects to scatter (give `objects` or select them)', 'POLL_FAILED');
        if (p.scale_max < p.scale_min)
          throw new OperatorError('scale_max is smaller than scale_min', 'INVALID_PARAMS');
        const scene = new LayoutScene(ctx);
        const surf = scene.get(surface.id);
        if (!surf.mesh || surf.mesh.faces.length === 0)
          throw new OperatorError(`'${surface.name}' has no surface geometry to scatter on`, 'FAILED');
        const samples = sampleSurface(surf.mesh, surf.worldMatrix, p.count, p.seed, {
          minDistance: p.min_distance,
          maxSlope: p.max_slope,
        });
        const sources = ids.map((id) => ctx.doc.getObject(id)!);
        const linear = new Map(
          ids.map((id) => {
            const w = scene.world(id);
            w[12] = w[13] = w[14] = 0;
            return [id, w];
          }),
        );
        const rng = new Rng(p.seed, 0x5ca770);
        const placed: { src: ObjectData; world: Mat4 }[] = [];
        for (const smp of samples) {
          const pick = rng.int(0, sources.length - 1);
          const heading = rng.spread(Math.PI) * p.rotation_random;
          const tiltAxis = rng.range(0, 2 * Math.PI);
          const tilt = rng.next() * p.tilt_random;
          const s = rng.range(p.scale_min, p.scale_max);
          const src = sources[pick];
          const up: Vec3 = p.align_to_normal ? smp.normal : [0, 0, 1];
          let r = multiply4(
            axisAngle4([0, 0, 1], heading),
            axisAngle4([Math.cos(tiltAxis), Math.sin(tiltAxis), 0], tilt),
          );
          r = multiply4(rotationBetween([0, 0, 1], up), r);
          const pos: Vec3 = [
            smp.point[0] + up[0] * p.offset,
            smp.point[1] + up[1] * p.offset,
            smp.point[2] + up[2] * p.offset,
          ];
          const world = multiply4(
            translation4(pos),
            multiply4(r, multiply4(scaling4([s, s, s]), linear.get(src.id)!)),
          );
          placed.push({ src, world });
        }
        const copier = p.linked ? null : new DataCopier(ctx.doc);
        if (copier) checkCopyBudget(placed.reduce((n, c) => n + copier.size(c.src), 0));
        const inits: (Partial<ObjectData> & { type: ObjectType; name: string })[] = placed.map(
          ({ src, world }) => ({
            ...duplicateFields(src),
            data: copier ? copier.copy(src) : src.data,
            parent: null,
            parent_type: 'OBJECT',
            parent_bone: '',
            // unparented: the world matrix is the local one (eulers continue the source's rotation)
            ...transformFields(world, scene.get(src.id).data),
          }),
        );
        const created = addObjects(ctx.doc, inits);
        if (created.length) setSelection(ctx, created, created[created.length - 1]);
        if (created.length < p.count)
          ctx.report('WARNING', `Placed ${created.length} of ${p.count} copies (surface full or too steep)`);
        else ctx.report('INFO', `Scattered ${created.length} copies on '${surface.name}'`);
        return { objects: created, count: created.length, requested: p.count, surface: surface.id };
      },
    }),
  );

  // ------------------------------------------------------------------ dimensions
  reg.register(
    defineOperator({
      id: 'object.dimensions_set',
      label: 'Set Dimensions',
      description:
        "Scale objects to target dimensions in metres: the size of the evaluated geometry's bounding box along " +
        "the object's own X, Y, Z axes. space=WORLD (default) measures it in the world, including the scale of " +
        "parents (for unrotated objects it is the size scene.measure reports); space=LOCAL is Blender's " +
        "object.dimensions (local bounding box × the object's own scale, ignoring parents). Give any of x, y, " +
        'z; proportional=true scales all three axes by one factor (the smallest needed, so the object fits ' +
        'within every given dimension). Only the scale changes; flat axes (size 0) and objects without geometry ' +
        'are skipped with a warning. Returns the new dimensions (in `space`) and scale of every object.',
      category: 'Layout',
      redoable: true,
      schema: z.object({
        objects: objectsParam,
        x: z
          .number()
          .positive()
          .max(1e7)
          .optional()
          .describe('Target size along the object X axis in metres'),
        y: z
          .number()
          .positive()
          .max(1e7)
          .optional()
          .describe('Target size along the object Y axis in metres'),
        z: z
          .number()
          .positive()
          .max(1e7)
          .optional()
          .describe('Target size along the object Z axis in metres'),
        proportional: z
          .boolean()
          .default(false)
          .describe('Keep the proportions: scale every axis by the same (smallest) factor'),
        space: z
          .enum(['WORLD', 'LOCAL'])
          .default('WORLD')
          .describe(
            "WORLD: world-space sizes along the object's axes (parent scales included); LOCAL: Blender's " +
              "object.dimensions (the object's own scale only)",
          ),
      }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const wanted = [p.x, p.y, p.z];
        if (wanted.every((v) => v === undefined))
          throw new OperatorError('Give at least one of x, y, z', 'INVALID_PARAMS');
        const ids = requireObjects(ctx, p.objects);
        const scene = new LayoutScene(ctx);
        const out = [];
        for (const id of ids) {
          const o = scene.get(id).data;
          const lb = scene.localBounds(id);
          if (!lb) {
            ctx.report('WARNING', `'${o.name}' has no geometry to measure; skipped`);
            continue;
          }
          const size = boundsSize(lb);
          // world: the length of the object's world axes (own and parent scale); local: own scale
          const wm = scene.world(id);
          const axisScale =
            p.space === 'WORLD'
              ? [0, 1, 2].map((k) => Math.hypot(wm[k * 4], wm[k * 4 + 1], wm[k * 4 + 2]))
              : o.scale.map(Math.abs);
          // both are proportional to the object's own scale on that axis
          const dims = size.map((v, k) => v * axisScale[k]);
          const factor: (number | null)[] = wanted.map((w, k) => {
            if (w === undefined) return null;
            if (!(dims[k] > 1e-12)) {
              ctx.report('WARNING', `'${o.name}' is flat along ${AXES[k]}; that axis cannot be scaled`);
              return null;
            }
            return w / dims[k];
          });
          let f: number[];
          if (p.proportional) {
            const given = factor.filter((v): v is number => v !== null);
            if (!given.length) continue;
            const m = Math.min(...given);
            f = [m, m, m];
          } else f = factor.map((v) => v ?? 1);
          const scale = clean3(o.scale.map((v, k) => v * f[k]) as Vec3);
          ctx.doc.updateObject(id, { scale });
          scene.touch(id);
          out.push({
            object: id,
            name: o.name,
            dimensions: r3(dims.map((v, k) => v * f[k]) as Vec3),
            scale: r3(scale),
          });
        }
        scene.commit();
        return { space: p.space, objects: out };
      },
    }),
  );

  // ------------------------------------------------------------------ queries (no undo step)
  reg.register(
    defineOperator({
      id: 'scene.measure',
      label: 'Measure',
      description:
        'Measure objects without changing anything: per object the world origin, world-space bounding box ' +
        '(min, max, center, size) of the evaluated geometry, Blender dimensions (bounding box along its own ' +
        'axes × its own scale) and world_dimensions (the same box measured in the world, parent scales ' +
        'included; what object.dimensions_set space=WORLD sets); the bounding box around all of them; and for ' +
        'every pair (up to 25 objects) the distance ' +
        'between origins and between bounding box centres, the gap between the bounding boxes (0 when they ' +
        'overlap) and the exact closest distance between the actual surfaces (meshes, curves, text and the ' +
        'geometry of collection instances) with the closest points (0 when they touch; intersecting=true when ' +
        'they cross). Surface distances are computed nearest pairs first within a time budget of about 3 s: ' +
        "pairs left without one carry surface_distance_skipped: 'time budget' (a WARNING says so; measure fewer " +
        'objects at a time to get them all) or that an object has no surface geometry (empty, camera, light, ' +
        'wire curve); `surface_distances` counts {computed, skipped (time budget), no_surface}, which add up to ' +
        'the number of pairs. More than 25 objects give no ' +
        'pairs (`distances_skipped` says why). Units: metres. `frame` measures the scene at another frame ' +
        '(animated, driven or simulated objects) without changing the current frame.',
      category: 'Scene',
      undo: false,
      schema: z.object({
        objects: z
          .array(z.string())
          .optional()
          .describe(
            'Objects by id or name (default: the selected objects, or every visible object when none are)',
          ),
        surface_distance: z
          .boolean()
          .default(true)
          .describe(
            'Compute the closest surface-to-surface distance of each pair (nearest pairs first, about 3 s in all)',
          ),
        frame: z
          .number()
          .optional()
          .describe(
            'Frame to evaluate (animation, drivers, constraints, physics), default: the current frame; the current frame is not changed',
          ),
      }),
      execute(ctx, p) {
        const scene = new LayoutScene(ctx, p.frame ?? ctx.state.frame);
        let ids = p.objects?.length
          ? resolveObjectIds(ctx, p.objects)
          : ctx.state.selectedIds.filter((id) => scene.ev.byId.has(id));
        if (!ids.length) ids = scene.ev.objects.filter((o) => o.visible).map((o) => o.id);
        ids = [...new Set(ids)];
        const objects = ids.map((id) => {
          const o = scene.get(id);
          const b = scene.bounds(id);
          const lb = scene.localBounds(id);
          const w = scene.world(id);
          return {
            object: id,
            name: o.name,
            type: o.type,
            location: r3(translationOf(w)),
            has_geometry: scene.hasGeometry(id),
            bounds: { ...boundsOut(b), center: r3(boundsCenter(b)), size: r3(boundsSize(b)) },
            dimensions: r3(
              lb ? (boundsSize(lb).map((v, k) => v * Math.abs(o.data.scale[k])) as Vec3) : [0, 0, 0],
            ),
            world_dimensions: r3(
              lb
                ? (boundsSize(lb).map((v, k) => v * Math.hypot(w[k * 4], w[k * 4 + 1], w[k * 4 + 2])) as Vec3)
                : [0, 0, 0],
            ),
          };
        });
        const all = ids.length ? ids.map((id) => scene.bounds(id)).reduce(unionBounds) : emptyBounds();
        // world-space triangles per object (its mesh, or the geometry of the collection it instances),
        // built once and shared by all pairs
        const triangles = new Map<string, WorldTriangles | null>();
        const trianglesOf = (id: string): WorldTriangles | null => {
          let t = triangles.get(id);
          if (t === undefined) {
            const parts = scene.geometryTargets(id).map((g) => ({ mesh: g.mesh, matrix: g.matrix }));
            t = parts.length ? new WorldTriangles(parts) : null;
            triangles.set(id, (t = t && t.count > 0 ? t : null));
          }
          return t;
        };
        const distances: Record<string, unknown>[] = [];
        if (ids.length >= 2 && ids.length <= MEASURE_MAX_PAIR_OBJECTS) {
          for (let i = 0; i < ids.length; i++)
            for (let j = i + 1; j < ids.length; j++) {
              const a = ids[i];
              const b = ids[j];
              const ba = scene.bounds(a);
              const bb = scene.bounds(b);
              const oa = translationOf(scene.world(a));
              const ob = translationOf(scene.world(b));
              const ca = boundsCenter(ba);
              const cb = boundsCenter(bb);
              const entry: Record<string, unknown> = {
                a,
                b,
                a_name: nameOf(ctx, a),
                b_name: nameOf(ctx, b),
                origin_distance: round(Math.hypot(oa[0] - ob[0], oa[1] - ob[1], oa[2] - ob[2])),
                center_distance: round(Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2])),
                bounds_gap: round(boundsGap(ba, bb)),
              };
              distances.push(entry);
            }
        }
        // exact surface distances, nearest pairs (by bounding box gap) first, within a time budget; every
        // pair without one says why (surface_distance_skipped), and computed + skipped + no_surface
        // counts all pairs
        let computed = 0;
        let skipped = 0;
        let noSurface = 0;
        if (p.surface_distance && distances.length) {
          const deadline = Date.now() + MEASURE_SURFACE_BUDGET_MS;
          const order = distances
            .map((e, k) => ({ e, k }))
            .sort((x, y) => (x.e.bounds_gap as number) - (y.e.bounds_gap as number) || x.k - y.k);
          /** The pair's object without surface geometry (empty, camera, light, wire curve), if any. */
          const surfaceless = (e: Record<string, unknown>, built: boolean): string | null => {
            for (const key of ['a', 'b'] as const) {
              const id = e[key] as string;
              if (built ? !trianglesOf(id) : !scene.hasGeometry(id)) return e[`${key}_name`] as string;
            }
            return null;
          };
          for (const { e } of order) {
            let none = surfaceless(e, false);
            if (none === null && Date.now() > deadline) {
              e.surface_distance_skipped = 'time budget';
              skipped++;
              continue;
            }
            none ??= surfaceless(e, true);
            const d =
              none === null
                ? triangleSetDistance(trianglesOf(e.a as string)!, trianglesOf(e.b as string)!)
                : null;
            if (!d) {
              e.surface_distance_skipped = `'${none}' has no surface geometry (faces)`;
              noSurface++;
              continue;
            }
            e.surface_distance = round(d.distance);
            e.closest_points = [r3(d.pointA), r3(d.pointB)];
            e.intersecting = d.intersecting;
            computed++;
          }
          if (skipped)
            ctx.report(
              'WARNING',
              `scene.measure: surface distances computed for ${computed} of the ${computed + skipped} pairs ` +
                `of objects with surfaces (time budget); the others have surface_distance_skipped 'time budget' ` +
                `(measure fewer objects at a time)`,
            );
        }
        const tooMany = ids.length > MEASURE_MAX_PAIR_OBJECTS;
        if (tooMany)
          ctx.report(
            'WARNING',
            `scene.measure: ${ids.length} objects: pairwise distances need at most ${MEASURE_MAX_PAIR_OBJECTS} objects`,
          );
        return {
          ...(p.frame !== undefined ? { frame: scene.ev.frame } : {}),
          objects,
          bounds: isEmptyBounds(all)
            ? null
            : { ...boundsOut(all), center: r3(boundsCenter(all)), size: r3(boundsSize(all)) },
          ...(ids.length >= 2 && !tooMany ? { distances } : {}),
          ...(p.surface_distance && distances.length
            ? { surface_distances: { computed, skipped, no_surface: noSurface } }
            : {}),
          ...(tooMany
            ? {
                distances_skipped: `${ids.length} objects: pairwise distances need at most ${MEASURE_MAX_PAIR_OBJECTS} objects`,
              }
            : {}),
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'scene.raycast',
      label: 'Ray Cast',
      description:
        'Cast a ray (world space) against the evaluated visible geometry: mesh, curve and text objects and, by ' +
        'default, their instances (collection instances, particles). Does not change anything. Returns ' +
        '{hit: true, object (id; the instanced source for instances), name, instancer (id or null), point, ' +
        'normal (unit face normal, world space), distance (metres), face (index), front (hit the front side)} or ' +
        '{hit: false}; with all=true a `hits` list of every surface along the ray, nearest first (surfaces of ' +
        'different objects at the same distance, e.g. a glass standing on a slab, are all listed). `frame` casts ' +
        'against the scene at another frame without changing the current frame.',
      category: 'Scene',
      undo: false,
      schema: z.object({
        origin: vec3.describe('World-space start of the ray in metres'),
        direction: vec3
          .default([0, 0, -1])
          .describe('Ray direction (normalized internally; default straight down)'),
        max_distance: z
          .number()
          .positive()
          .max(1e9)
          .default(1e6)
          .describe('Maximum distance from the origin in metres'),
        objects: z
          .array(z.string())
          .optional()
          .describe('Only hit these objects (ids or names; hidden ones too), default: every visible object'),
        exclude: z.array(z.string()).optional().describe('Objects (ids or names) the ray passes through'),
        include_instances: z
          .boolean()
          .default(true)
          .describe('Also hit collection-instance and particle instances'),
        all: z.boolean().default(false).describe('Return every hit along the ray (up to 64), nearest first'),
        frame: z
          .number()
          .optional()
          .describe(
            'Frame to evaluate (animation, drivers, constraints, physics), default: the current frame; the current frame is not changed',
          ),
      }),
      execute(ctx, p) {
        const scene = new LayoutScene(ctx, p.frame ?? ctx.state.frame);
        const only = p.objects?.length ? new Set(p.objects.map((r) => resolveOne(ctx, r).id)) : null;
        const exclude = new Set((p.exclude ?? []).map((r) => resolveOne(ctx, r).id));
        const rc = new SceneRaycaster(scene.targets({ exclude, only, instances: p.include_instances }));
        const dir = p.direction as Vec3;
        if (!(Math.hypot(dir[0], dir[1], dir[2]) > 0))
          throw new OperatorError('direction must not be zero', 'INVALID_PARAMS');
        // the frame is echoed when one was asked for
        const frame = p.frame !== undefined ? { frame: scene.ev.frame } : {};
        if (p.all) {
          const hits = rc.castAll(p.origin as Vec3, dir, p.max_distance, 64).map((h) => hitInfo(ctx, h));
          return { hit: hits.length > 0, count: hits.length, hits, ...frame };
        }
        const hit = rc.cast(p.origin as Vec3, dir, p.max_distance);
        return hit ? { hit: true, ...hitInfo(ctx, hit), ...frame } : { hit: false, ...frame };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'scene.stats',
      label: 'Scene Statistics',
      description:
        "Scene statistics without changing anything (like Blender's status bar statistics): object counts (total, " +
        'visible, selected, per type), evaluated geometry of the visible objects after modifiers (vertices, ' +
        'edges, faces, triangles), instances (count and triangles), data-block counts, animation (F-curves, ' +
        'drivers, frame range) and the world bounding box of the visible geometry. selected_only restricts the ' +
        'geometry totals to the selected objects; `frame` evaluates another frame without changing the current one.',
      category: 'Scene',
      undo: false,
      schema: z.object({
        selected_only: z.boolean().default(false).describe('Count the geometry of the selected objects only'),
        frame: z
          .number()
          .optional()
          .describe(
            'Frame to evaluate (animation, drivers, constraints, physics), default: the current frame; the current frame is not changed',
          ),
      }),
      execute(ctx, p) {
        const ev = new SceneEvaluator(ctx.doc).evaluate(p.frame ?? ctx.state.frame);
        const selected = new Set(ctx.state.selectedIds);
        const byType: Record<string, number> = {};
        const geo = { vertices: 0, edges: 0, faces: 0, triangles: 0 };
        const bounds = emptyBounds();
        const grow = (mesh: MeshData, m: Mat4) => {
          const b = pointsBounds(mesh.positions, m);
          if (!isEmptyBounds(b)) Object.assign(bounds, unionBounds(isEmptyBounds(bounds) ? b : bounds, b));
        };
        let visible = 0;
        for (const o of ev.objects) {
          byType[o.type] = (byType[o.type] ?? 0) + 1;
          if (o.visible) visible++;
          const counted = p.selected_only ? selected.has(o.id) : o.visible;
          if (!counted || !o.mesh) continue;
          const s = cachedStats(o.mesh);
          geo.vertices += s.vertices;
          geo.edges += s.edges;
          geo.faces += s.faces;
          geo.triangles += s.triangles;
          grow(o.mesh, o.worldMatrix);
        }
        let instances = 0;
        let instanceTris = 0;
        for (const inst of ev.instances) {
          const owner = ev.byId.get(inst.ownerId);
          const src = ev.byId.get(inst.sourceId);
          if (!owner || !src?.mesh) continue;
          if (p.selected_only ? !selected.has(owner.id) : !owner.visible) continue;
          instances++;
          instanceTris += cachedStats(src.mesh).triangles;
          grow(src.mesh, inst.matrix);
        }
        const doc = ctx.doc;
        const scene = doc.getScene();
        return {
          frame: ctx.state.frame,
          objects: {
            total: ev.objects.length,
            visible,
            selected: ctx.state.selectedIds.filter((id) => ev.byId.has(id)).length,
            by_type: byType,
          },
          geometry: geo,
          instances: { count: instances, triangles: instanceTris },
          total_triangles: geo.triangles + instanceTris,
          datablocks: {
            meshes: doc.map('meshes').size,
            materials: doc.map('materials').size,
            curves: doc.map('curves').size,
            armatures: doc.map('armatures').size,
            lights: doc.map('lights').size,
            cameras: doc.map('cameras').size,
            images: doc.map('images').size,
            collections: doc.map('collections').size,
          },
          animation: {
            fcurves: doc.map('fcurves').size,
            drivers: doc.map('drivers').size,
            frame_start: scene.frame_start,
            frame_end: scene.frame_end,
            fps: scene.fps,
          },
          bounds: isEmptyBounds(bounds) ? null : { ...boundsOut(bounds), size: r3(boundsSize(bounds)) },
        };
      },
    }),
  );
}

// Mesh statistics per (immutable) mesh instance: edge counting is the expensive part.
const statsCache = new WeakMap<MeshData, MeshStats>();
function cachedStats(mesh: MeshData): MeshStats {
  let s = statsCache.get(mesh);
  if (!s) statsCache.set(mesh, (s = meshStats(mesh)));
  return s;
}
