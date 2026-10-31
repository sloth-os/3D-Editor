import { z } from 'zod';
import * as Y from 'yjs';
import type { Mat4, Vec3 } from '../math/types';
import {
  axisAngle4,
  decompose4,
  determinant4,
  identity4,
  invert4,
  multiply4,
  scaling4,
  translation4,
} from '../math/mat4';
import { transformDirection3, transformPoint3 } from '../math/vec3';
import type { SceneDoc } from '../doc/scene-doc';
import type { ObjectData, ObjectType } from '../doc/types';
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
  computeDrop,
  meshDistance,
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

  constructor(private readonly ctx: OperatorContext) {
    this.ev = new SceneEvaluator(ctx.doc).evaluate(ctx.state.frame);
  }

  /** Transform state of the frame, only built for bone parents (the evaluated scene has the rest). */
  private get fs(): FrameState {
    return (this.fsCache ??= new FrameState(this.ctx.doc, this.ctx.state.frame));
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
    const local = transformDirection3(invert4(this.parentWorld(id)), delta);
    this.ctx.doc.updateObject(id, {
      location: clean3([o.location[0] + local[0], o.location[1] + local[1], o.location[2] + local[2]]),
    });
    this.record(id, translation4(delta));
  }

  /** Gives an object a new world matrix (written as location / rotation / scale through its parent). */
  setWorld(id: string, world: Readonly<Mat4>): void {
    if (!world.every(Number.isFinite)) return;
    const cur = this.world(id);
    const local = multiply4(invert4(this.parentWorld(id)), world);
    const d = decompose4(local);
    if (![...d.location, ...d.rotation, ...d.scale].every(Number.isFinite)) return;
    this.ctx.doc.updateObject(id, {
      location: clean3(d.location),
      rotation_euler: clean3(d.rotation),
      scale: clean3(d.scale),
    });
    this.record(id, multiply4(world, invert4(cur)));
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
   * excluding `exclude` (and instances they own), restricted to `only` when given.
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
        if (!owner || !src?.mesh || ex.has(owner.id)) continue;
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

/** Unique Blender-style names ("Tree", "Tree.001", …) for many new objects without rescanning. */
function objectNamer(doc: SceneDoc): (base: string) => string {
  const taken = new Set<string>();
  for (const y of doc.map('objects').values()) taken.add(String((y as Y.Map<unknown>).get('name') ?? ''));
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
  const unique = objectNamer(doc);
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

/** Copy of an object's data block (for non-linked duplicates); the same id when it has none. */
function copyData(doc: SceneDoc, o: ObjectData): string | null {
  if (!o.data) return null;
  switch (o.type) {
    case 'MESH': {
      const mesh = doc.getMeshCopy(o.data);
      if (!mesh) return o.data;
      const id = doc.addMesh(doc.getMeshBlock(o.data)?.name ?? o.name, mesh);
      const keys = doc.getShapeKeys(o.data);
      if (keys.length) doc.setShapeKeys(id, keys);
      const groups = doc.getVertexGroups(o.data);
      if (groups.length) doc.setVertexGroups(id, groups);
      return id;
    }
    case 'CURVE':
    case 'FONT': {
      const c = doc.getCurve(o.data);
      if (!c) return o.data;
      const { id: _id, ...rest } = c;
      return doc.addCurve(rest);
    }
    case 'ARMATURE': {
      const a = doc.getArmature(o.data);
      if (!a) return o.data;
      const { id: _id, ...rest } = a;
      return doc.addArmature(rest);
    }
    case 'LIGHT': {
      const l = doc.getLight(o.data);
      if (!l) return o.data;
      const { id: _id, ...rest } = l;
      return doc.addLight(rest);
    }
    case 'CAMERA': {
      const c = doc.getCamera(o.data);
      if (!c) return o.data;
      const { id: _id, ...rest } = c;
      return doc.addCamera(rest);
    }
    default:
      return o.data;
  }
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
        'Move objects straight down (or up, out of a surface they are sunk into) until their lowest geometry rests ' +
        'on the surface below: other visible mesh, curve and text objects (or only `surface`), using the evaluated ' +
        'world-space geometry of both (rays from every vertex down onto the surfaces and from the surface vertices ' +
        'under the object up onto it). The supporting surface is the first one below the top of the object, so ' +
        'surfaces above it are ignored. Where nothing is below, the plane z = 0 is the ground (ground_plane). ' +
        'align_to_normal first tilts the object so its local +Z follows the surface normal under its centre. ' +
        'Objects are dropped independently (never onto each other). Returns per object whether it was dropped, ' +
        'the vertical move (metres), the contact point on the surface, its normal, the surface name (or ' +
        '"ground plane") and the new world origin.',
      category: 'Layout',
      redoable: true,
      schema: z.object({
        objects: objectsParam,
        surface: z
          .array(z.string())
          .optional()
          .describe(
            'Surface objects to drop onto, by id or name (default: every other visible geometry object)',
          ),
        ground_plane: z
          .boolean()
          .default(true)
          .describe('Where no surface is below the object, use the infinite plane z = 0 as the ground'),
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
        const targets = new SceneRaycaster(scene.targets({ exclude: moving, only }));
        const out = [];
        for (const id of scene.byDepth(ids)) {
          let world = scene.world(id);
          const origin = translationOf(world);
          const pointsOf = (w: Mat4): ArrayLike<number> => {
            const pts = p.use_origin ? null : scene.localPoints(id);
            if (!pts) return translationOf(w);
            const world3 = new Float64Array(pts.length - (pts.length % 3));
            for (let i = 0; i < world3.length; i += 3) {
              const q = transformPoint3(w, [pts[i], pts[i + 1], pts[i + 2]]);
              world3[i] = q[0];
              world3[i + 1] = q[1];
              world3[i + 2] = q[2];
            }
            return world3;
          };
          let rotated = false;
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
              const r = rotationBetween(axisOf(world, 2), probe.normal);
              const turn = multiply4(
                translation4(origin),
                multiply4(r, translation4([-origin[0], -origin[1], -origin[2]])),
              );
              world = multiply4(turn, world);
              rotated = true;
            }
          }
          const pts = pointsOf(world);
          const geometry =
            p.use_origin || !scene.hasGeometry(id)
              ? null
              : new SceneRaycaster(scene.geometryTargets(id, world));
          const drop = computeDrop(pts, geometry, targets, p.ground_plane);
          if (!drop) {
            ctx.report('WARNING', `Nothing below '${nameOf(ctx, id)}' to drop onto`);
            if (rotated) scene.setWorld(id, world);
            out.push({ object: id, name: nameOf(ctx, id), dropped: false });
            continue;
          }
          const dz = drop.dz + p.offset;
          const final = multiply4(translation4([0, 0, dz]), world);
          if (rotated) scene.setWorld(id, final);
          else scene.translate(id, [0, 0, dz]);
          out.push({
            object: id,
            name: nameOf(ctx, id),
            dropped: true,
            moved: round(dz),
            contact: r3(drop.point),
            normal: r3(drop.normal),
            surface: drop.target ? nameOf(ctx, drop.target.objectId) : 'ground plane',
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
        'Cast a ray (world space) against the visible geometry (or only `surface`) and place the objects at the ' +
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
            'Objects the ray may hit, by id or name (default: every visible geometry object except the moved ones)',
          ),
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
        const rc = new SceneRaycaster(scene.targets({ exclude: moving, only }));
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
          const r = rotationBetween(axisOf(wRef, 2), n);
          const g = multiply4(translation4(target), multiply4(r, translation4([-s[0], -s[1], -s[2]])));
          for (const id of scene.byDepth(roots)) scene.setWorld(id, multiply4(g, scene.world(id)));
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
          const rot = trackRotation(dir, track, up, [0, 0, 1], axisOf(w, AXIS_INDEX[up]));
          if (!rot) {
            ctx.report('WARNING', `'${nameOf(ctx, id)}' is at the target point; not rotated`);
            continue;
          }
          const s = [0, 1, 2].map((k) => Math.hypot(w[k * 4], w[k * 4 + 1], w[k * 4 + 2]));
          if (determinant4(w) < 0) {
            // keep a mirrored object mirrored, on the axis that is neither tracked nor up
            s[3 - AXIS_INDEX[track.slice(-1) as UpAxis] - AXIS_INDEX[up]] *= -1;
          }
          scene.setWorld(id, multiply4(translation4(pos), multiply4(rot, scaling4(s as Vec3))));
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
        '(Alt+D, edits apply to all); false makes independent copies. Copies keep parents, collections, ' +
        `materials and modifiers. At most ${MAX_LAYOUT_OBJECTS} new objects. Originals and copies become the ` +
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
          .describe('CIRCLE: arc covered in radians, counter-clockwise seen from above (2π = full circle)'),
        rotate: z
          .boolean()
          .default(true)
          .describe(
            'CIRCLE: rotate the copies with the circle (false: copies keep the original orientation)',
          ),
        linked: z
          .boolean()
          .default(true)
          .describe('Share the object data between copies (linked duplicates)'),
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
          const full = Math.abs(Math.abs(p.angle) - 2 * Math.PI) < 1e-9 || Math.abs(p.angle) > 2 * Math.PI;
          const step = full ? p.angle / items : items > 1 ? p.angle / (items - 1) : 0;
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
        const inits: (Partial<ObjectData> & { type: ObjectType; name: string })[] = [];
        const plan: { item: number; src: ObjectData }[] = [];
        transforms.forEach((m, item) => {
          for (const src of sources) {
            const f = duplicateFields(src);
            f.data = p.linked ? src.data : copyData(ctx.doc, src);
            if (!(src.parent && inGroup.has(src.parent))) {
              // group roots: new world = item transform · current world, written through the same parent
              const world = multiply4(m, scene.world(src.id));
              const d = decompose4(multiply4(invert4(scene.parentWorld(src.id)), world));
              f.location = clean3(d.location);
              f.rotation_euler = clean3(d.rotation);
              f.scale = clean3(d.scale);
            }
            inits.push(f);
            plan.push({ item, src });
          }
        });
        const created = addObjects(ctx.doc, inits);
        // re-link parents inside each copied group
        const copyOf = new Map<string, string>();
        created.forEach((id, i) => copyOf.set(`${plan[i].item}:${plan[i].src.id}`, id));
        created.forEach((id, i) => {
          const { item, src } = plan[i];
          if (src.parent && inGroup.has(src.parent))
            ctx.doc.updateObject(id, { parent: copyOf.get(`${item}:${src.parent}`) ?? src.parent });
        });
        const perItem = transforms.map((_, item) => created.filter((_, i) => plan[i].item === item));
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
          .describe('Share the object data with the source (linked duplicates)'),
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
        const inits: (Partial<ObjectData> & { type: ObjectType; name: string })[] = [];
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
          const d = decompose4(world);
          const f = duplicateFields(src);
          f.data = p.linked ? src.data : copyData(ctx.doc, src);
          inits.push({
            ...f,
            parent: null,
            parent_type: 'OBJECT',
            parent_bone: '',
            location: clean3(d.location),
            rotation_euler: clean3(d.rotation),
            scale: clean3(d.scale),
          });
        }
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
        "Scale objects to target dimensions in metres (Blender's object.dimensions: the size of the evaluated " +
        "geometry's bounding box along the object's own X, Y, Z axes, including its scale). Give any of x, y, z; " +
        'proportional=true scales all three axes by one factor (the smallest needed, so the object fits within ' +
        'every given dimension). Only the scale changes; flat axes (size 0) and objects without geometry are ' +
        'skipped with a warning. Returns the new dimensions and scale of every object.',
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
          const dims = size.map((v, k) => v * Math.abs(o.scale[k]));
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
            dimensions: r3(size.map((v, k) => v * Math.abs(scale[k])) as Vec3),
            scale: r3(scale),
          });
        }
        scene.commit();
        return { objects: out };
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
        '(min, max, center, size) of the evaluated geometry and Blender dimensions (bounding box along its own ' +
        'axes × scale); the bounding box around all of them; and for every pair (up to 25 objects) the distance ' +
        'between origins and between bounding box centres, the gap between the bounding boxes (0 when they ' +
        'overlap) and, up to 8 objects, the closest distance between the actual surfaces with the closest points ' +
        '(0 and intersecting=true when they cross). Units: metres.',
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
          .describe('Compute the closest surface-to-surface distance of each pair (at most 8 objects)'),
      }),
      execute(ctx, p) {
        const scene = new LayoutScene(ctx);
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
          };
        });
        const all = ids.length ? ids.map((id) => scene.bounds(id)).reduce(unionBounds) : emptyBounds();
        const distances = [];
        if (ids.length >= 2 && ids.length <= 25) {
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
              const ma = scene.get(a).mesh;
              const mb = scene.get(b).mesh;
              if (p.surface_distance && ids.length <= 8 && ma && mb) {
                const d = meshDistance(
                  { mesh: ma, matrix: scene.world(a) },
                  { mesh: mb, matrix: scene.world(b) },
                );
                if (d) {
                  entry.surface_distance = round(d.distance);
                  entry.closest_points = [r3(d.pointA), r3(d.pointB)];
                  entry.intersecting = d.intersecting;
                }
              }
              distances.push(entry);
            }
        }
        return {
          objects,
          bounds: isEmptyBounds(all)
            ? null
            : { ...boundsOut(all), center: r3(boundsCenter(all)), size: r3(boundsSize(all)) },
          ...(ids.length >= 2 ? { distances } : {}),
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
        '{hit: false}; with all=true a `hits` list of every surface along the ray, nearest first.',
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
      }),
      execute(ctx, p) {
        const scene = new LayoutScene(ctx);
        const only = p.objects?.length ? new Set(p.objects.map((r) => resolveOne(ctx, r).id)) : null;
        const exclude = new Set((p.exclude ?? []).map((r) => resolveOne(ctx, r).id));
        const rc = new SceneRaycaster(scene.targets({ exclude, only, instances: p.include_instances }));
        const dir = p.direction as Vec3;
        if (!(Math.hypot(dir[0], dir[1], dir[2]) > 0))
          throw new OperatorError('direction must not be zero', 'INVALID_PARAMS');
        if (p.all) {
          const hits = rc.castAll(p.origin as Vec3, dir, p.max_distance, 64).map((h) => hitInfo(ctx, h));
          return { hit: hits.length > 0, count: hits.length, hits };
        }
        const hit = rc.cast(p.origin as Vec3, dir, p.max_distance);
        return hit ? { hit: true, ...hitInfo(ctx, hit) } : { hit: false };
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
        'geometry totals to the selected objects.',
      category: 'Scene',
      undo: false,
      schema: z.object({
        selected_only: z.boolean().default(false).describe('Count the geometry of the selected objects only'),
      }),
      execute(ctx, p) {
        const ev = new SceneEvaluator(ctx.doc).evaluate(ctx.state.frame);
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
