import { getState } from 'yjs';
import type { Mat4 } from '../math/types';
import type { MeshData } from '../mesh/types';
import type { SceneDoc } from '../doc/scene-doc';
import { stableStringify } from '../util/json';
import {
  sanitizeRigidBody,
  sanitizeRigidBodyWorld,
  worldParams,
  type MotionMode,
  type WorldParams,
} from './settings';
import type { CollisionShape } from '../doc/types';
import { Simulation, type BodyInput, type RigidBodyIssue } from './simulation';

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
  /** Last frame the simulation runs to (later frames hold its state). */
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
 * new simulation. Animated (kinematic) bodies are compared frame by frame against the
 * transforms the cache was built with, up to the frame being evaluated; a difference re-runs
 * the simulation.
 */

interface CacheEntry {
  sim: Simulation | null;
  signature: string;
  /** Change token of the document state the entry was last checked against. */
  token: string | null;
  /** Kinematic transforms of cached frames are verified up to this frame since that check. */
  kinematicVerified: number;
}

const caches = new WeakMap<object, CacheEntry>();
const trackers = new WeakMap<object, { version: number }>();

const cacheKey = (doc: SceneDoc): object => doc.ydoc ?? doc;

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

const meshKeys = new WeakMap<MeshData, string>();

/** Content hash of a mesh's vertex positions and faces (memoised per mesh instance). */
function meshKey(mesh: MeshData): string {
  let key = meshKeys.get(mesh);
  if (key !== undefined) return key;
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  const mix = (x: number) => {
    h1 = Math.imul(h1 ^ x, 0x01000193);
    h2 = Math.imul(h2 ^ x, 0x5bd1e995);
    h2 ^= h2 >>> 13;
  };
  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);
  const pos = Array.isArray(mesh.positions) ? mesh.positions : [];
  mix(pos.length);
  for (const v of pos) {
    f64[0] = v;
    mix(u32[0]);
    mix(u32[1]);
  }
  const faces = Array.isArray(mesh.faces) ? mesh.faces : [];
  mix(faces.length);
  for (const f of faces) {
    if (!Array.isArray(f)) {
      mix(-1);
      continue;
    }
    mix(f.length);
    for (const i of f) mix(typeof i === 'number' ? i | 0 : -1);
  }
  key = `${pos.length}:${faces.length}:${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
  meshKeys.set(mesh, key);
  return key;
}

/** Rigid body objects of the scene (validated settings, id order) and the signature of all inputs. */
function collectInputs(
  doc: SceneDoc,
  host: RigidBodyHost,
  params: WorldParams,
): { inputs: BodyInput[]; signature: string } {
  const found: { id: string; rb: NonNullable<ReturnType<typeof sanitizeRigidBody>> }[] = [];
  for (const o of doc.listObjects()) {
    const rb = sanitizeRigidBody(o.rigid_body);
    if (rb) found.push({ id: o.id, rb });
  }
  if (!found.length) return { inputs: [], signature: 'empty' };
  found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const transforms = host.transformsAt(params.frameStart);
  const parts = [stableStringify(params)];
  const inputs = found.map(({ id, rb }): BodyInput => {
    const matrix = transforms.get(id) ?? null;
    const mesh = host.meshOf(id);
    parts.push(id, stableStringify(rb), mesh ? meshKey(mesh) : '-', matrix ? matrix.join(',') : '-');
    return { id, rb, matrix, mesh };
  });
  return { inputs, signature: parts.join('|') };
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
      entry = {
        sim: inputs.length ? new Simulation(inputs, params) : null,
        signature: collected.signature,
        token,
        kinematicVerified: params.frameStart,
      };
      caches.set(key, entry);
    } else {
      entry.token = token;
      // the animation of kinematic bodies may have changed: re-check cached frames lazily
      entry.kinematicVerified = params.frameStart;
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
    const target = Math.min(frame, sim.frameEnd);
    const need = Math.ceil(target);
    if (sim.kinematic.length) {
      // animation of kinematic bodies may have changed since these frames were simulated
      const upTo = Math.min(need, sim.current);
      for (let f = entry.kinematicVerified + 1; f <= upTo; f++) {
        if (!sim.kinematicMatches(f, host.transformsAt(f))) {
          inputs ??= collectInputs(doc, host, params).inputs;
          sim = entry.sim = new Simulation(inputs, params);
          this.lastIssues = sim.issues;
          break;
        }
        entry.kinematicVerified = f;
      }
    }
    while (sim.current < need) sim.advance(sim.kinematic.length ? host.transformsAt(sim.current + 1) : null);
    entry.kinematicVerified = Math.max(entry.kinematicVerified, need);
    return sim.matrices(target);
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
  return info;
}

/** The current state of a document's rigid body cache, or null when nothing is cached. */
export function rigidBodyCacheInfo(doc: SceneDoc): RigidBodyCacheInfo | null {
  const sim = caches.get(cacheKey(doc))?.sim;
  if (!sim) return null;
  return {
    frame_start: sim.frameStart,
    frame_end: sim.frameEnd,
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
