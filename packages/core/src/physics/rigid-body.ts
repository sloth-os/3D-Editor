import { getState } from 'yjs';
import type { Mat4 } from '../math/types';
import type { MeshData } from '../mesh/types';
import type { SceneDoc } from '../doc/scene-doc';
import { stableStringify } from '../util/json';
import {
  sanitizeRigidBody,
  sanitizeRigidBodyWorld,
  simulatedFrameEnd,
  worldParams,
  type MotionMode,
  type WorldParams,
} from './settings';
import type { AnimTargetType, CollisionShape, DriverData, FCurve } from '../doc/types';
import { meshKey } from './mesh-key';
import { clearCollisionShapeCache } from './shapes';
import {
  SIMULATION_BYTES_PER_KINEMATIC_FRAME,
  checkSimulation,
  simulationCacheBytes,
  simulationOutsideHeapBytes,
} from './memory';
import {
  Simulation,
  compareBodyOrder,
  type BodyInput,
  type RigidBodyIssue,
  type SimulationOptions,
} from './simulation';

export type { RigidBodyIssue } from './simulation';

/**
 * Callbacks the simulator uses to read the scene. They must be pure functions of the document
 * (same answers for the same document state): simulation caches are shared per document.
 */
export interface RigidBodyHost {
  /** Unsimulated world matrices of all objects at a frame (animation, parenting, constraints). */
  transformsAt(frame: number): Map<string, Mat4>;
  /** Object-space mesh used to build collision shapes (null for non-mesh objects). */
  meshOf(id: string): MeshData | null;
}

/** State of a document's rigid body cache (see `rigidBodyCacheInfo`). */
export interface RigidBodyCacheInfo {
  frame_start: number;
  /**
   * Last frame the simulation runs to (later frames hold its state): frame_end, or later while
   * bodies released at or after it come to rest (see Simulation.runLimit).
   */
  frame_end: number;
  /** Frames simulated so far (the cache holds frame_start … simulated_to). */
  simulated_to: number;
  /** Simulated objects (ACTIVE, not animated) / all rigid bodies in the world. */
  active_bodies: number;
  bodies: number;
  /** Fixed time steps taken so far. */
  steps: number;
  issues: RigidBodyIssue[];
  /** Every simulated body: its collision shape after fallbacks and how it moves. */
  objects: { object: string; collision_shape: CollisionShape; motion: MotionMode; sleeping: boolean }[];
}

/*
 * Cache sharing and invalidation.
 *
 * Every evaluator of a document shares one simulation per document (keyed by its Y.Doc), so
 * the editor, renders and MCP queries do not each re-simulate from frame_start. The cache is
 * validated lazily: a change token (bumped after every Yjs transaction; inside a transaction it
 * also tracks the local clock and deletions) tells whether the document may have changed. Only
 * then the inputs are re-read: rigid body and world settings, gravity, fps, the meshes (content
 * hash) and the transforms at frame_start form a signature, and a different signature starts a
 * new simulation. The new simulation reuses the collision shapes of the previous one whose
 * inputs (mesh content, shape type, dynamics, exact scale) are unchanged (`shapeKey`), so an
 * edit does not rebuild a dense MESH collider. Animated (kinematic) bodies are compared frame
 * by frame against the transforms the cache was built with, up to the frame being evaluated; a
 * difference re-runs the simulation. Bodies released at a start frame are compared on the few
 * frames before it that drive them (Simulation.trackedAt). That check is only repeated after
 * edits that can change those transforms (see `animationInputsKey`, a hash of their inputs up to
 * the frames that matter), so editing unrelated objects, materials or meshes, or renaming the
 * holder of a prop, at a late frame does not re-evaluate every cached frame.
 */

interface CacheEntry {
  sim: Simulation | null;
  signature: string;
  /** Change token of the document state the entry was last checked against. */
  token: string | null;
  /** Kinematic transforms of cached frames are verified up to this frame since that check. */
  kinematicVerified: number;
  /** `animationInputsKey` of the animated bodies the verified frames were checked with. */
  kinematicKey: string;
  /**
   * Collision shapes the next simulation can reuse (by content key): the current simulation's,
   * or the last ones built while the scene has no rigid bodies.
   */
  shapeSource: ShapeSource | null;
}

type ShapeSource = NonNullable<SimulationOptions['reuse']>;

const caches = new WeakMap<object, CacheEntry>();
const trackers = new WeakMap<object, { version: number }>();

const cacheKey = (doc: SceneDoc): object => doc.ydoc ?? doc;

/*
 * The frames every cache keeps, for a host that counts its memory (the server: physics/memory.ts).
 * The documents that have had a simulation are held weakly; a Y.Doc's cache is dropped when the
 * document is destroyed (a closed project), so that its frames are neither kept nor counted.
 */
const simulatedKeys = new Set<WeakRef<object>>();
const registeredKeys = new WeakSet<object>();

function registerCache(key: object): void {
  if (registeredKeys.has(key)) return;
  registeredKeys.add(key);
  simulatedKeys.add(new WeakRef(key));
  const y = key as { on?: (event: 'destroy', f: () => void) => void };
  if (typeof y.on === 'function') y.on('destroy', () => caches.delete(key));
}

/**
 * Bytes the frames of `entry`'s simulation keep (physics/memory.ts), or only those outside the heap.
 * The animated transforms it recorded are counted as they were recorded: every frame for an animated
 * body, the frames up to their start for delayed ones (a frame's record is longer than the heap keeps
 * inside it, so they all live outside it).
 */
function entryBytes(entry: CacheEntry | undefined, outsideHeap: boolean): number {
  const sim = entry?.sim;
  if (!sim) return 0;
  const bodies = { simulated: sim.outputs.length, kinematic: 0 };
  const frames = sim.current - sim.frameStart;
  const records = SIMULATION_BYTES_PER_KINEMATIC_FRAME * sim.kinematicRecords;
  return (
    (outsideHeap ? simulationOutsideHeapBytes(bodies, frames) : simulationCacheBytes(bodies, frames)) +
    records
  );
}

/**
 * Bytes the rigid body cache of `doc` keeps: the frames simulated so far (physics/memory.ts
 * simulationCacheBytes; 0 when nothing is cached). They stay until the simulation's inputs change,
 * rigidbody.cache_free drops them or the document is destroyed.
 */
export function rigidBodyCacheBytes(doc: SceneDoc): number {
  return entryBytes(caches.get(cacheKey(doc)), false);
}

/**
 * Bytes the rigid body caches of every document of this process keep (see
 * {@link rigidBodyCacheBytes}); with `outsideHeap`, only the part outside the JavaScript heap
 * (physics/memory.ts simulationOutsideHeapBytes), which V8's heap statistics leave out.
 */
export function rigidBodyCachesBytes(opts: { outsideHeap?: boolean } = {}): number {
  let bytes = 0;
  for (const ref of simulatedKeys) {
    const key = ref.deref();
    if (key) bytes += entryBytes(caches.get(key), !!opts.outsideHeap);
    else simulatedKeys.delete(ref);
  }
  return bytes;
}

/** Token that changes whenever the document may have changed (null: unknown, always re-check). */
function changeToken(doc: SceneDoc): string | null {
  const y = doc.ydoc;
  if (!y || typeof y.on !== 'function') return null;
  let t = trackers.get(y);
  if (!t) {
    const tracker = { version: 0 };
    y.on('afterTransaction', () => {
      tracker.version++;
    });
    trackers.set(y, tracker);
    t = tracker;
  }
  const tr = y._transaction;
  if (!tr) return `${t.version}`;
  // inside a transaction: inserts advance the local clock, deletions grow the delete set
  let deletions = 0;
  for (const items of tr.deleteSet.clients.values()) deletions += items.length;
  return `${t.version}:${getState(y.store, y.clientID)}:${deletions}`;
}

/** Words of a 64-bit float, for hashing numbers. */
const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);

/**
 * A 64-bit hash (two 32-bit lanes with murmur3-style mixing) of a sequence of numbers and strings:
 * the fingerprint of inputs too large to keep as text (the keys of a long walk), cheap to update.
 */
class Hasher {
  private a = 0x9e3779b9 | 0;
  private b = 0x85ebca6b | 0;

  word(k: number): void {
    let x = Math.imul(k | 0, 0xcc9e2d51);
    x = (x << 15) | (x >>> 17);
    x = Math.imul(x, 0x1b873593);
    this.a ^= x;
    this.a = (this.a << 13) | (this.a >>> 19);
    this.a = (Math.imul(this.a, 5) + 0xe6546b64) | 0;
    let y = Math.imul((k | 0) ^ 0x5bd1e995, 0x2c1b3c6d);
    y = (y << 17) | (y >>> 15);
    y = Math.imul(y, 0x297a2d39);
    this.b ^= y;
    this.b = (this.b << 11) | (this.b >>> 21);
    this.b = (Math.imul(this.b, 9) + 0x7fe0a2d5) | 0;
  }

  num(v: number): void {
    F64[0] = v;
    this.word(U32[0]);
    this.word(U32[1]);
  }

  str(s: string): void {
    this.word(s.length);
    for (let i = 0; i < s.length; i++) this.word(s.charCodeAt(i));
  }

  digest(): string {
    const fmix = (h: number) => {
      h ^= h >>> 16;
      h = Math.imul(h, 0x85ebca6b);
      h ^= h >>> 13;
      h = Math.imul(h, 0xc2b2ae35);
      return (h ^ (h >>> 16)) >>> 0;
    };
    return fmix(this.a).toString(36) + '.' + fmix(this.b).toString(36);
  }
}

/** Object fields that never change a world matrix (left out of `animationInputsKey`). */
const NON_TRANSFORM_FIELDS = new Set<string>([
  'name',
  'collection',
  'material_slots',
  'hide_viewport',
  'hide_render',
  'hide_select',
  'display_type',
  'show_wire',
  'show_in_front',
  'color',
  'empty_display_type',
  'empty_display_size',
  'custom_props',
  'instance_type',
  'instance_collection',
  'particle_systems',
  'rigid_body',
]);

/** F-curves or drivers stored in `map` by `<target_type>:<target_id>`, read without copying them. */
function storedByTarget<T extends { target_type: AnimTargetType; target_id: string }>(
  map: { values(): IterableIterator<unknown> },
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const v of map.values()) {
    const it = v as T;
    if (!it || typeof it !== 'object') continue;
    const k = `${it.target_type}:${it.target_id}`;
    const l = out.get(k);
    if (l) l.push(it);
    else out.set(k, [it]);
  }
  return out;
}

/**
 * Hashes the F-curves of one datablock as far as they decide its values at frames up to `until`:
 * every key up to it and the two after it (the segment holding `until` and the automatic Bézier
 * slope of its end, or the slope of a LINEAR extrapolation), all keys when the curve cycles, has
 * modifiers or keys out of order.
 */
function hashCurves(h: Hasher, curves: readonly FCurve[], until: number): void {
  const sorted = [...curves].sort((x, y) =>
    x.path === y.path ? x.index - y.index : x.path < y.path ? -1 : 1,
  );
  h.word(sorted.length);
  for (const fc of sorted) {
    h.str(String(fc.path));
    h.num(fc.index);
    h.str(String(fc.extrapolation));
    h.word(fc.mute ? 1 : 0);
    const mods = fc.modifiers?.length ? stableStringify(fc.modifiers) : '';
    h.str(mods);
    const keys = Array.isArray(fc.keyframes) ? fc.keyframes : [];
    let all = !Number.isFinite(until) || fc.extrapolation === 'CYCLIC' || mods !== '';
    for (let i = 1; i < keys.length && !all; i++) if (!(keys[i].frame >= keys[i - 1].frame)) all = true;
    let after = 0;
    let n = 0;
    for (const k of keys) {
      if (!all && !(k.frame <= until) && ++after > 2) break;
      h.num(k.frame);
      h.num(k.value);
      h.str(String(k.interpolation));
      h.str(k.easing === undefined ? '' : String(k.easing));
      n++;
    }
    h.word(n);
  }
}

/**
 * Fingerprint of everything the unsimulated world matrices of the given objects can depend on: the
 * objects, their parents, every object mentioned in their constraints or armature poses
 * (constraint / bone constraint targets), the datablocks driver variables read, armature and curve
 * data (bone parents, follow-path curves), transitively, with the F-curves and drivers of all of
 * these. It over-approximates (any object id found in constraint or pose data counts), so an
 * unchanged key means unchanged transforms. Fields that never move an object (its name, materials,
 * visibility, custom properties…) are left out, so editing them keeps the key. With `until`, only
 * the frames up to `until.get(id)` matter for object `id` (a body released at its start frame): an
 * input reached from such objects only is fingerprinted with the keys that decide those frames.
 * The F-curves are hashed where they are stored, not copied: a long animation costs a pass over its
 * keys, not a copy and a text of them per edit.
 */
export function animationInputsKey(
  doc: SceneDoc,
  ids: readonly string[],
  until?: ReadonlyMap<string, number>,
): string {
  if (!ids.length) return '';
  const objects = new Map(doc.listObjects().map((o) => [o.id, o]));
  const fcurves = storedByTarget<FCurve>(doc.map('fcurves'));
  const drivers = storedByTarget<DriverData>(doc.map('drivers'));
  const visitIdsIn = (v: unknown, out: string[], depth = 0): void => {
    if (depth > 32) return;
    if (typeof v === 'string') {
      if (objects.has(v)) out.push(`object:${v}`);
    } else if (Array.isArray(v)) for (const x of v) visitIdsIn(x, out, depth + 1);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) visitIdsIn(x, out, depth + 1);
  };
  /** The inputs one input depends on (its parents, targets, data, driver variables). */
  const dependencies = (key: string): string[] => {
    const out: string[] = [];
    if (key.startsWith('object:')) {
      const o = objects.get(key.slice(7));
      if (o) {
        if (o.parent) out.push(`object:${o.parent}`);
        visitIdsIn(o.constraints, out);
        visitIdsIn(o.pose, out);
        if (o.data && o.type === 'ARMATURE') out.push(`armature:${o.data}`);
        if (o.data && o.type === 'CURVE') out.push(`curve:${o.data}`);
      }
    }
    for (const d of drivers.get(key) ?? [])
      for (const v of d.variables ?? []) out.push(`${v.target_type}:${v.target_id}`);
    return out;
  };
  // every input reached, with the latest frame that matters for it (the bodies released latest first)
  const limit = new Map<string, number>();
  const roots = ids
    .map((id) => ({ id, until: until?.get(id) ?? Infinity }))
    .sort((a, b) => b.until - a.until);
  for (const root of roots) {
    const queue = [`object:${root.id}`];
    while (queue.length) {
      const key = queue.pop()!;
      const seen = limit.get(key);
      if (seen !== undefined && seen >= root.until) continue;
      limit.set(key, root.until);
      queue.push(...dependencies(key));
    }
  }
  const parts: string[] = [];
  for (const [key, last] of limit) {
    const sep = key.indexOf(':');
    const type = key.slice(0, sep);
    const id = key.slice(sep + 1);
    let data: unknown = null;
    switch (type) {
      case 'object': {
        const o = objects.get(id);
        data = o
          ? Object.fromEntries(Object.entries(o).filter(([field]) => !NON_TRANSFORM_FIELDS.has(field)))
          : null;
        break;
      }
      case 'armature':
        data = doc.getArmature(id);
        break;
      case 'curve':
        data = doc.getCurve(id);
        break;
      case 'material':
        data = doc.getMaterial(id);
        break;
      case 'light':
        data = doc.getLight(id);
        break;
      case 'camera':
        data = doc.getCamera(id);
        break;
      case 'world':
        data = doc.getWorld();
        break;
      case 'scene':
        data = doc.getScene();
        break;
      case 'mesh':
        data = doc.getShapeKeys(id);
        break;
    }
    const h = new Hasher();
    h.str(stableStringify([data, drivers.get(key) ?? []]));
    hashCurves(h, fcurves.get(key) ?? [], last);
    parts.push(`${key}<${last}=${h.digest()}`);
  }
  return parts.sort().join('|');
}

/**
 * Rigid body objects of the scene (validated settings, in solver order: by start pose, see
 * `compareBodyOrder`) and the signature of all inputs.
 */
function collectInputs(
  doc: SceneDoc,
  host: RigidBodyHost,
  params: WorldParams,
): { inputs: BodyInput[]; signature: string } {
  const found: { id: string; name: string; rb: NonNullable<ReturnType<typeof sanitizeRigidBody>> }[] = [];
  for (const o of doc.listObjects()) {
    const rb = sanitizeRigidBody(o.rigid_body);
    if (rb) found.push({ id: o.id, name: o.name, rb });
  }
  if (!found.length) return { inputs: [], signature: 'empty' };
  const transforms = host.transformsAt(params.frameStart);
  const inputs = found
    .map(({ id, name, rb }): BodyInput => ({
      id,
      name,
      rb,
      matrix: transforms.get(id) ?? null,
      mesh: host.meshOf(id),
    }))
    .sort(compareBodyOrder);
  // the order of the parts records the solver order (bodies starting at the same pose: by name);
  // frame_end is left out: the frames before it do not depend on it (see Simulation.setFrameEnd)
  const parts = [stableStringify({ ...params, frameEnd: null })];
  for (const { id, rb, mesh, matrix } of inputs)
    parts.push(id, stableStringify(rb), mesh ? meshKey(mesh) : '-', matrix ? matrix.join(',') : '-');
  return { inputs, signature: parts.join('|') };
}

/**
 * `animationInputsKey` of the bodies of a simulation that follow their animation at some frame (the
 * animated ones at every frame, the delayed ones up to their start frame; '' when it has none).
 */
function kinematicKeyOf(doc: SceneDoc, sim: Simulation | null): string {
  if (!sim) return '';
  return animationInputsKey(
    doc,
    sim.tracked.map((b) => b.id),
    sim.releaseFrames(),
  );
}

/**
 * The document's cache entry, checked against the current inputs: when the document may have
 * changed (change token), the inputs are re-read and a different signature starts a new
 * simulation (built at frame_start, not stepped yet).
 */
function validEntry(
  doc: SceneDoc,
  host: RigidBodyHost,
  params: WorldParams,
): { entry: CacheEntry; inputs: BodyInput[] | null } {
  const key = cacheKey(doc);
  const token = changeToken(doc);
  let entry = caches.get(key);
  let inputs: BodyInput[] | null = null;
  if (!entry || token === null || entry.token !== token) {
    const collected = collectInputs(doc, host, params);
    inputs = collected.inputs;
    if (!entry || entry.signature !== collected.signature) {
      // unchanged collision shapes are reused, so only the simulation itself starts over
      const reuse = entry?.shapeSource ?? null;
      const sim = inputs.length ? new Simulation(inputs, params, { reuse }) : null;
      entry = {
        sim,
        signature: collected.signature,
        token,
        kinematicVerified: params.frameStart,
        kinematicKey: kinematicKeyOf(doc, sim),
        // without bodies only the shapes are kept (not the old simulation's frame cache)
        shapeSource: sim ?? (reuse && { shapes: reuse.shapes, spareShapes: reuse.spareShapes }),
      };
      caches.set(key, entry);
      if (sim) registerCache(key);
    } else {
      entry.token = token;
      if (
        entry.sim &&
        entry.sim.frameEnd !== simulatedFrameEnd(params) &&
        !entry.sim.setFrameEnd(params)
      ) {
        // other bodies are released past the new end than past the old one: the run starts over
        const sim = new Simulation(inputs, params, { reuse: entry.sim });
        entry.sim = sim;
        entry.shapeSource = sim;
        entry.kinematicVerified = params.frameStart;
        entry.kinematicKey = kinematicKeyOf(doc, sim);
        return { entry, inputs };
      }
      // the animation of kinematic bodies may have changed: re-check cached frames lazily
      const animation = kinematicKeyOf(doc, entry.sim);
      if (animation !== entry.kinematicKey) {
        entry.kinematicKey = animation;
        entry.kinematicVerified = params.frameStart;
      }
    }
  }
  return { entry, inputs };
}

/**
 * Rigid body world simulation with an incremental frame cache (like Blender's point cache):
 * the cache is invalidated when simulation inputs change and re-simulated from frame_start.
 *
 * Semantics follow Blender: at or before the world's frame_start objects keep their own
 * (animated) transforms; afterwards ACTIVE bodies are simulated (frames after frame_end hold the
 * last state). PASSIVE bodies collide at their frame_start pose unless "Animated" (`kinematic`),
 * in which case they follow their animation and push ACTIVE bodies. Bodies are built from the
 * object's mesh and world scale at frame_start; the returned matrices keep that scale.
 * `collision_margin` is the contact detection distance (shapes are not inflated by it), and
 * bodies that have come to rest sleep until something touches them (Bullet deactivation).
 */
export class RigidBodySimulator {
  private doc: SceneDoc | null = null;
  private lastIssues: readonly RigidBodyIssue[] = [];

  /** Problems found with rigid body objects in the last evaluation (bodies left out, fallbacks). */
  get issues(): readonly RigidBodyIssue[] {
    return this.lastIssues;
  }

  /**
   * Simulated world matrices at `frame` for ACTIVE (non-animated) bodies, or null when the rigid
   * body world is disabled, has no active bodies, or `frame` is not after its frame_start.
   * Simulates incrementally from the last cached frame up to min(frame, frame_end);
   * fractional frames interpolate between the neighbouring frames.
   */
  evaluate(doc: SceneDoc, frame: number, host: RigidBodyHost): Map<string, Mat4> | null {
    this.doc = doc;
    this.lastIssues = [];
    const scene = doc.getScene();
    if (!sanitizeRigidBodyWorld(scene.rigidbody_world).enabled || !Number.isFinite(frame)) return null;
    const params = worldParams(scene);
    if (frame <= params.frameStart) return null;
    const valid = validEntry(doc, host, params);
    const entry = valid.entry;
    let inputs = valid.inputs;
    let sim = entry.sim;
    if (!sim) return null;
    this.lastIssues = sim.issues;
    if (sim.outputs.length === 0) return null;
    // the frames up to the run's end (frame_end, or later while late releases settle: runLimit)
    const targetOf = (s: Simulation) => Math.min(frame, s.endFrame() ?? s.runLimit);
    if (sim.tracked.length) {
      // animation of kinematic bodies may have changed since these frames were simulated (frames
      // where no body followed its animation have nothing to check)
      const upTo = Math.min(Math.ceil(targetOf(sim)), sim.current);
      for (let f = entry.kinematicVerified + 1; f <= upTo; f++) {
        if (sim.recordedAt(f) && !sim.kinematicMatches(f, host.transformsAt(f))) {
          inputs ??= collectInputs(doc, host, params).inputs;
          sim = entry.sim = new Simulation(inputs, params, { reuse: sim });
          entry.shapeSource = sim;
          this.lastIssues = sim.issues;
          break;
        }
        entry.kinematicVerified = f;
      }
    }
    const target = targetOf(sim);
    const need = Math.ceil(target);
    // a host that keeps its memory in bounds (the server) refuses frames whose cache does not fit
    if (sim.current < need && !sim.ended) {
      const frames = need - sim.current;
      checkSimulation(
        {
          simulated: sim.outputs.length,
          kinematic: Math.ceil(sim.recordsBetween(sim.current + 1, need) / frames),
        },
        need,
        frames,
        doc,
      );
    }
    while (sim.current < need && !sim.ended)
      sim.advance(sim.needsTransforms(sim.current + 1) ? host.transformsAt(sim.current + 1) : null);
    entry.kinematicVerified = Math.max(entry.kinematicVerified, need);
    return sim.matrices(Math.min(target, sim.endFrame() ?? Infinity));
  }

  /** Drops the simulation cache (of the document last evaluated); the next evaluation re-simulates. */
  reset(): void {
    if (this.doc) caches.delete(cacheKey(this.doc));
    this.lastIssues = [];
  }
}

/**
 * Makes sure the document's simulation is set up for its current inputs (bodies and shapes
 * built, nothing simulated beyond the cache) and returns its state, or null when the scene has
 * no rigid bodies. Used to inspect the setup without stepping.
 */
export function inspectRigidBodies(doc: SceneDoc, host: RigidBodyHost): RigidBodyCacheInfo | null {
  validEntry(doc, host, worldParams(doc.getScene()));
  return rigidBodyCacheInfo(doc);
}

/**
 * Frees the rigid body cache of a document (shared by all its evaluators), so the next
 * evaluation re-simulates from frame_start. Returns the state of the freed cache, or null when
 * there was none.
 */
export function freeRigidBodyCache(doc: SceneDoc): RigidBodyCacheInfo | null {
  const info = rigidBodyCacheInfo(doc);
  caches.delete(cacheKey(doc));
  // and the collision shapes shared between simulations: the next one starts from scratch
  clearCollisionShapeCache();
  return info;
}

/** The current state of a document's rigid body cache, or null when nothing is cached. */
export function rigidBodyCacheInfo(doc: SceneDoc): RigidBodyCacheInfo | null {
  const sim = caches.get(cacheKey(doc))?.sim;
  if (!sim) return null;
  return {
    frame_start: sim.frameStart,
    frame_end: sim.endFrame() ?? sim.runLimit,
    simulated_to: sim.current,
    active_bodies: sim.outputs.length,
    bodies: sim.bodies.length,
    steps: sim.world.steps,
    issues: [...sim.issues],
    objects: sim.bodies.map((b) => ({
      object: b.id,
      collision_shape: b.shapeType,
      motion: b.mode,
      sleeping: b.mode === 'DYNAMIC' && !b.awake,
    })),
  };
}
