import { SceneEvaluator, type EvaluatedScene, type SceneDoc } from '@3d-editor/core';

/*
 * Scene evaluations of the MCP inspection tools (get_scene, get_object, get_mesh_data …), cached
 * per document state and frame. Every tool call used to build a new SceneEvaluator, so each call
 * re-evaluated the whole scene from scratch (modifier stacks, curves, instancing, the rigid body
 * simulation): ~120 ms per get_object on a mid-sized scene, which made checking motion over many
 * frames and objects slow. Now each document keeps one evaluator per mode (their geometry and
 * simulation caches survive between calls, like in the browser and the render threads) and the
 * last evaluations by frame; any change to the document drops the evaluations.
 *
 * Evaluated scenes are shared between callers: treat them as immutable.
 */

/** RENDER: modifiers and curves with their render settings (what renders show); VIEWPORT: the editor's. */
export type EvalMode = 'RENDER' | 'VIEWPORT';

/** Evaluations kept per document (most recently used frames of both modes). */
export const MAX_CACHED_EVALUATIONS = 16;

interface DocEvaluations {
  /** Number of document changes seen (bumped by every Yjs update). */
  version: number;
  evaluators: Record<EvalMode, SceneEvaluator>;
  /** By `${mode}:${frame}`, least recently used first. */
  results: Map<string, EvaluatedScene>;
  /** Evaluations computed (not served from the cache), for tests and diagnostics. */
  misses: number;
  hits: number;
}

const caches = new WeakMap<SceneDoc, DocEvaluations>();

function entry(scene: SceneDoc): DocEvaluations {
  let e = caches.get(scene);
  if (!e) {
    const created: DocEvaluations = {
      version: 0,
      evaluators: { RENDER: new SceneEvaluator(scene), VIEWPORT: new SceneEvaluator(scene) },
      results: new Map(),
      misses: 0,
      hits: 0,
    };
    // every change (local, remote, undo) emits an update after its transaction
    scene.ydoc.on('update', () => {
      created.version++;
      created.results.clear();
    });
    caches.set(scene, created);
    e = created;
  }
  return e;
}

/**
 * The scene evaluated at `frame` (cached until the document changes). RENDER evaluations use the
 * modifiers' and curves' render settings (SUBSURF render_levels, SCREW render_steps, show_render,
 * render_resolution_u, every particle), VIEWPORT ones the viewport settings.
 */
export function evaluateCached(scene: SceneDoc, frame: number, mode: EvalMode): EvaluatedScene {
  const e = entry(scene);
  const key = `${mode}:${frame}`;
  const hit = e.results.get(key);
  if (hit) {
    // most recently used last
    e.results.delete(key);
    e.results.set(key, hit);
    e.hits++;
    return hit;
  }
  const version = e.version;
  const ev = e.evaluators[mode].evaluate(frame, { forRender: mode === 'RENDER' });
  e.misses++;
  // an evaluation that ran while the document changed (it cannot here, evaluation is synchronous)
  // would describe neither state: only keep results of an unchanged document
  if (e.version === version) {
    e.results.set(key, ev);
    while (e.results.size > MAX_CACHED_EVALUATIONS) e.results.delete(e.results.keys().next().value!);
  }
  return ev;
}

/** Cache statistics of a document (tests and diagnostics). */
export function evaluationStats(scene: SceneDoc): {
  version: number;
  cached: number;
  hits: number;
  misses: number;
} {
  const e = entry(scene);
  return { version: e.version, cached: e.results.size, hits: e.hits, misses: e.misses };
}
