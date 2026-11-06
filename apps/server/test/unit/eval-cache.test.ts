import { afterEach, describe, expect, it, vi } from 'vitest';
import { SceneDoc, SceneEvaluator, createOperatorRegistry, createEditorState } from '@3d-editor/core';
import { evaluateCached, evaluationStats, MAX_CACHED_EVALUATIONS } from '../../src/mcp/eval-cache';
import { describeObject, summarizeScene } from '../../src/mcp/scene-summary';

/*
 * get_object / get_scene re-evaluated the whole scene on every call (clockwork-orrery v2 #2:
 * ~120 ms per call, so checking motion over many frames took 15–30 s). Evaluations are cached per
 * document state, frame and mode now, with persistent evaluators per document.
 */

const registry = createOperatorRegistry();

function scene(): SceneDoc {
  const doc = SceneDoc.create({ name: 'Cache' });
  const ctx = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: () => undefined,
  } as Parameters<typeof registry.run>[0];
  const cube = doc.listObjects().find((o) => o.name === 'Cube')!;
  ctx.state.selectedIds = [cube.id];
  ctx.state.activeId = cube.id;
  expect(registry.run(ctx, 'object.modifier_add', { type: 'SUBSURF' }).ok).toBe(true);
  return doc;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('evaluation cache', () => {
  it('evaluates a document state once per frame and mode', () => {
    const doc = scene();
    const spy = vi.spyOn(SceneEvaluator.prototype, 'evaluate');
    const a = evaluateCached(doc, 1, 'RENDER');
    expect(evaluateCached(doc, 1, 'RENDER')).toBe(a);
    expect(evaluateCached(doc, 1, 'VIEWPORT')).not.toBe(a);
    expect(evaluateCached(doc, 2, 'RENDER')).not.toBe(a);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls.map((c) => c[1]?.forRender)).toEqual([true, false, true]);
  });

  it('drops the evaluations when the document changes', () => {
    const doc = scene();
    const before = evaluateCached(doc, 1, 'RENDER');
    const version = evaluationStats(doc).version;
    const cube = doc.listObjects().find((o) => o.name === 'Cube')!;
    doc.transact(() => doc.updateObject(cube.id, { location: [1, 2, 3] }));
    expect(evaluationStats(doc).version).toBeGreaterThan(version);
    const after = evaluateCached(doc, 1, 'RENDER');
    expect(after).not.toBe(before);
    expect(after.byId.get(cube.id)!.worldMatrix.slice(12, 15)).toEqual([1, 2, 3]);
  });

  it('keeps the most recently used evaluations only', () => {
    const doc = scene();
    for (let f = 1; f <= MAX_CACHED_EVALUATIONS + 4; f++) evaluateCached(doc, f, 'RENDER');
    expect(evaluationStats(doc).cached).toBe(MAX_CACHED_EVALUATIONS);
    const misses = evaluationStats(doc).misses;
    evaluateCached(doc, MAX_CACHED_EVALUATIONS + 4, 'RENDER'); // still cached
    evaluateCached(doc, 1, 'RENDER'); // evicted
    expect(evaluationStats(doc).misses).toBe(misses + 1);
  });

  it('serves repeated get_object / get_scene summaries of a frame from one evaluation per mode', () => {
    const doc = scene();
    const spy = vi.spyOn(SceneEvaluator.prototype, 'evaluate');
    const cube = doc.listObjects().find((o) => o.name === 'Cube')!;
    const camera = doc.listObjects().find((o) => o.name === 'Camera')!;
    for (let i = 0; i < 5; i++) {
      describeObject(doc, cube, 7);
      describeObject(doc, camera, 7);
      summarizeScene(doc, { frame: 7 });
    }
    // the cube has a modifier: the viewport may show other geometry, so both modes are evaluated
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
