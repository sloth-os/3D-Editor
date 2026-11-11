import {
  EVALUATED_INSTANCE_BYTES,
  MeshMemoryError,
  SceneEvaluator,
  decodedMeshBytes,
  sceneEvaluationBytes,
  type EvaluatedScene,
  type EvaluationSize,
  type MeshData,
  type SceneDoc,
} from '@3d-editor/core';
import { evaluationCacheBytes, evaluationCheck, type EvaluationCheck } from '../render/memory';

/*
 * Scene evaluations of the MCP inspection tools (get_scene, get_object, get_mesh_data …), cached
 * per document state and frame. Every tool call used to build a new SceneEvaluator, so each call
 * re-evaluated the whole scene from scratch (modifier stacks, curves, instancing, the rigid body
 * simulation): ~120 ms per get_object on a mid-sized scene, which made checking motion over many
 * frames and objects slow. Now each document keeps one evaluator per mode (their geometry and
 * simulation caches survive between calls, like in the browser and the render processes) and the
 * last evaluations by frame; any change to the document drops the evaluations.
 *
 * The cached evaluations of all documents share a budget of heap (render/memory.ts
 * evaluationCacheBytes): each keeps about 1.6 KB per object (core memory-objects.ts
 * sceneEvaluationBytes), the instances that changed since the evaluation before, and the meshes its
 * modifiers and shape keys made (each counted once however many evaluations hold it), and the least
 * recently used evaluations go first. Before an evaluation that is not cached, the server checks
 * that its peak heap fits into the free heap less the reserve (render/memory.ts evaluationCheck: one
 * of 32 MB or more), dropping every cached evaluation when it does not; one that still does not fit
 * is not run and fails with code OUT_OF_MEMORY (a MeshMemoryError, which the tools report as such).
 * The instances a scene expands (at most 200,000, about 75 MB at the peak) are counted once
 * evaluated, not in the check. Unbounded, the evaluations of a project of many objects, which the
 * limit per project allows, filled the heap frame by frame until V8 ended the server.
 *
 * Evaluated scenes are shared between callers: treat them as immutable.
 */

/** RENDER: modifiers and curves with their render settings (what renders show); VIEWPORT: the editor's. */
export type EvalMode = 'RENDER' | 'VIEWPORT';

/** Evaluations kept per document (most recently used frames of both modes), within the heap budget. */
export const MAX_CACHED_EVALUATIONS = 16;

interface CachedEvaluation {
  doc: DocEvaluations;
  key: string;
  ev: EvaluatedScene;
  /** Heap its objects keep (bytes). */
  bytes: number;
  /** The instance list and the meshes made by modifiers it holds (counted in {@link held}). */
  holds: object[];
}

interface DocEvaluations {
  /** Number of document changes seen (bumped by every Yjs update). */
  version: number;
  evaluators: Record<EvalMode, SceneEvaluator>;
  /** By `${mode}:${frame}`, least recently used first. */
  results: Map<string, CachedEvaluation>;
  /** What an evaluation of the document's state `version` takes. */
  size: { version: number; value: EvaluationSize } | null;
  /** Evaluations computed (not served from the cache), for tests and diagnostics. */
  misses: number;
  hits: number;
}

const caches = new WeakMap<SceneDoc, DocEvaluations>();

/** The cached evaluations of every document, least recently used first. */
const lru = new Set<CachedEvaluation>();

/**
 * Instance lists and meshes made by modifiers that cached evaluations hold: their heap and the
 * number of evaluations holding them (evaluations of frames that change nothing share them).
 */
const held = new Map<object, { bytes: number; users: number }>();

/** Heap of all cached evaluations (bytes). */
let cachedBytes = 0;

/** The memory limits of the cache: the server's (render/memory.ts); tests replace them. */
export const evaluationMemory: {
  /** Heap the cached evaluations of all documents keep at most (bytes). */
  budget: () => number;
  /** Why an evaluation is not run (null: run it); `release` drops every cached evaluation. */
  check: EvaluationCheck;
} = {
  budget: () => evaluationCacheBytes(),
  check: evaluationCheck(),
};

const meshBytesCache = new WeakMap<MeshData, number>();

/** Heap of a mesh an evaluation made (mesh/memory.ts decodedMeshBytes of its counts). */
function meshBytes(m: MeshData): number {
  let bytes = meshBytesCache.get(m);
  if (bytes === undefined) {
    let corners = 0;
    for (const f of m.faces) corners += f.length;
    bytes = decodedMeshBytes({
      vertices: m.positions.length / 3,
      faces: m.faces.length,
      corners,
      uvs: !!m.uvs,
      colors: !!m.colors,
      edgeAttrs: Object.keys(m.edgeAttrs).length,
      looseEdges: m.looseEdges.length / 2,
    });
    meshBytesCache.set(m, bytes);
  }
  return bytes;
}

/** The instance list and the meshes made by modifiers or shape keys that `ev` holds. */
function holdsOf(ev: EvaluatedScene): object[] {
  const out = new Set<object>();
  if (ev.instances.length) out.add(ev.instances);
  for (const o of ev.objects) if (o.mesh && o.mesh !== o.baseMesh) out.add(o.mesh);
  return [...out];
}

function keep(c: CachedEvaluation): void {
  lru.add(c);
  c.doc.results.set(c.key, c);
  cachedBytes += c.bytes;
  for (const x of c.holds) {
    const h = held.get(x);
    if (h) {
      h.users++;
      continue;
    }
    const bytes = Array.isArray(x) ? EVALUATED_INSTANCE_BYTES * x.length : meshBytes(x as MeshData);
    held.set(x, { bytes, users: 1 });
    cachedBytes += bytes;
  }
}

function drop(c: CachedEvaluation): void {
  if (!lru.delete(c)) return;
  c.doc.results.delete(c.key);
  cachedBytes -= c.bytes;
  for (const x of c.holds) {
    const h = held.get(x);
    if (!h || --h.users > 0) continue;
    held.delete(x);
    cachedBytes -= h.bytes;
  }
}

/** Drops the cached evaluations of `e`, or of every document. */
function dropAll(e?: DocEvaluations): void {
  for (const c of [...(e ? e.results.values() : lru)]) drop(c);
}

/** Drops the least recently used evaluations until `extra` more bytes fit into the budget. */
function makeRoom(extra: number): void {
  const budget = evaluationMemory.budget();
  for (const c of lru) {
    if (cachedBytes + extra <= budget) break;
    drop(c);
  }
}

function entry(scene: SceneDoc): DocEvaluations {
  let e = caches.get(scene);
  if (!e) {
    const created: DocEvaluations = {
      version: 0,
      evaluators: { RENDER: new SceneEvaluator(scene), VIEWPORT: new SceneEvaluator(scene) },
      results: new Map(),
      size: null,
      misses: 0,
      hits: 0,
    };
    // every change (local, remote, undo) emits an update after its transaction
    scene.ydoc.on('update', () => {
      created.version++;
      dropAll(created);
    });
    // a closed project's evaluations leave the budget with it
    scene.ydoc.on('destroy', () => dropAll(created));
    caches.set(scene, created);
    e = created;
  }
  return e;
}

/** What an evaluation of the document's current state takes (estimated once per state). */
function evaluationSize(e: DocEvaluations, scene: SceneDoc): EvaluationSize {
  if (e.size?.version !== e.version) e.size = { version: e.version, value: sceneEvaluationBytes(scene) };
  return e.size.value;
}

/**
 * The scene evaluated at `frame` (cached until the document changes). RENDER evaluations use the
 * modifiers' and curves' render settings (SUBSURF render_levels, SCREW render_steps, show_render,
 * render_resolution_u, every particle), VIEWPORT ones the viewport settings. Throws a
 * MeshMemoryError (code OUT_OF_MEMORY) when the evaluation would not fit into the server's heap.
 */
export function evaluateCached(scene: SceneDoc, frame: number, mode: EvalMode): EvaluatedScene {
  const e = entry(scene);
  const key = `${mode}:${frame}`;
  const hit = e.results.get(key);
  if (hit) {
    // most recently used last
    lru.delete(hit);
    lru.add(hit);
    e.results.delete(key);
    e.results.set(key, hit);
    e.hits++;
    return hit.ev;
  }
  const version = e.version;
  const size = evaluationSize(e, scene);
  // room in the cache for one more evaluation of this size, and in the heap for its peak
  makeRoom(size.retained);
  const refused = evaluationMemory.check(size.objects, size.peak, () => dropAll());
  if (refused) throw new MeshMemoryError(refused);
  const ev = e.evaluators[mode].evaluate(frame, { forRender: mode === 'RENDER' });
  e.misses++;
  // an evaluation that ran while the document changed (it cannot here, evaluation is synchronous)
  // would describe neither state: only keep results of an unchanged document
  if (e.version === version) {
    keep({ doc: e, key, ev, bytes: ev.objects.length * size.perObject, holds: holdsOf(ev) });
    while (e.results.size > MAX_CACHED_EVALUATIONS) drop(e.results.values().next().value!);
    // within the budget, this evaluation included (one larger than the budget is not kept)
    makeRoom(0);
  }
  return ev;
}

/**
 * Cache statistics of a document (tests and diagnostics); `bytes`: the heap of the cached
 * evaluations of all documents.
 */
export function evaluationStats(scene: SceneDoc): {
  version: number;
  cached: number;
  hits: number;
  misses: number;
  bytes: number;
} {
  const e = entry(scene);
  return { version: e.version, cached: e.results.size, hits: e.hits, misses: e.misses, bytes: cachedBytes };
}
