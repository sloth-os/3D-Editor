import { afterEach, describe, expect, it } from 'vitest';
import {
  EVALUATED_INSTANCE_BYTES,
  OPERATOR_FIXED_BYTES,
  SceneDoc,
  createEditorState,
  createOperatorRegistry,
  decodedMeshBytes,
  isMeshMemoryError,
  sceneEvaluationBytes,
  type MeshData,
} from '@3d-editor/core';
import { evaluateCached, evaluationMemory, evaluationStats } from '../../src/mcp/eval-cache';
import { evaluationCheck } from '../../src/render/memory';

/*
 * The inspection tools cache each project's last evaluations by frame (eval-cache.ts). Every
 * evaluation keeps about 1.6 KB per object, and nothing counted them: a project of 30,000 linked
 * objects, which the limit per project allowed on a 1 GB heap, ended the server at the 15th frame
 * get_object evaluated. The evaluations of all projects now share a budget (render/memory.ts
 * evaluationCacheBytes; here a test's own), counted from the objects, the instances that changed
 * and the meshes modifiers made, and an evaluation whose peak does not fit is refused.
 */

const registry = createOperatorRegistry();
const MB = 1024 * 1024;
const budget = evaluationMemory.budget;
const check = evaluationMemory.check;
const docs: SceneDoc[] = [];

function run(ctx: Parameters<typeof registry.run>[0], id: string, params: object): void {
  const res = registry.run(ctx, id, params);
  expect(res.ok, `${id}: ${res.ok ? '' : res.error}`).toBe(true);
}

/** A project the operators `build` runs make. */
function scene(build: (run: (id: string, params: object) => void, doc: SceneDoc) => void): SceneDoc {
  const doc = SceneDoc.create({ name: 'Evaluations', empty: true });
  docs.push(doc);
  const ctx = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: () => undefined,
  } as Parameters<typeof registry.run>[0];
  build((id, params) => run(ctx, id, params), doc);
  return doc;
}

/** A cube and `n` - 1 linked duplicates of it. */
function linkedCubes(n: number): SceneDoc {
  return scene((op) => {
    op('mesh.primitive_cube_add', { name: 'Cube' });
    op('object.array_place', { objects: ['Cube'], linked: true, count: n });
  });
}

/** A plane scattering `count` cubes, its location animated when `animated`. */
function scatter(count: number, animated: boolean): SceneDoc {
  return scene((op, doc) => {
    op('mesh.primitive_plane_add', { size: 20, name: 'Ground' });
    op('mesh.primitive_cube_add', { size: 0.1, location: [0, 0, 5], name: 'Pebble' });
    op('object.scatter_add', { surface: 'Ground', objects: ['Pebble'], count });
    if (!animated) return;
    const ground = doc.findObjectByName('Ground')!;
    doc.setFCurve({
      target_type: 'object',
      target_id: ground.id,
      path: 'location',
      index: 0,
      keyframes: [
        { frame: 1, value: 0, interpolation: 'LINEAR' },
        { frame: 10, value: 5, interpolation: 'LINEAR' },
      ],
      extrapolation: 'CONSTANT',
      mute: false,
    } as never);
  });
}

/** Heap of a mesh as the cache counts it (core mesh/memory.ts). */
function meshBytes(m: MeshData): number {
  return decodedMeshBytes({
    vertices: m.positions.length / 3,
    faces: m.faces.length,
    corners: m.faces.reduce((a, f) => a + f.length, 0),
    uvs: !!m.uvs,
    colors: !!m.colors,
    edgeAttrs: Object.keys(m.edgeAttrs).length,
    looseEdges: m.looseEdges.length / 2,
  });
}

afterEach(() => {
  evaluationMemory.budget = budget;
  evaluationMemory.check = check;
  // a closed project's evaluations leave the budget
  for (const d of docs.splice(0)) d.ydoc.destroy();
});

describe('evaluation cache memory', () => {
  it('keeps the evaluations of all projects within the heap budget, least recently used first', () => {
    const doc = linkedCubes(300);
    const size = sceneEvaluationBytes(doc);
    expect(size.objects).toBe(300);
    evaluationMemory.budget = () => 3.5 * size.retained;
    for (let f = 1; f <= 10; f++) evaluateCached(doc, f, 'RENDER');
    let stats = evaluationStats(doc);
    expect(stats.cached).toBe(3);
    expect(stats.bytes).toBe(3 * size.retained);
    // frames 8 to 10 are kept, the older ones went first
    evaluateCached(doc, 10, 'RENDER');
    expect(evaluationStats(doc).misses).toBe(stats.misses);
    evaluateCached(doc, 1, 'RENDER');
    expect(evaluationStats(doc).misses).toBe(stats.misses + 1);
    // another project's evaluations take the place of this one's
    const other = linkedCubes(300);
    for (let f = 1; f <= 3; f++) evaluateCached(other, f, 'RENDER');
    expect(evaluationStats(other).cached).toBe(3);
    stats = evaluationStats(doc);
    expect(stats.cached).toBe(0);
    expect(stats.bytes).toBe(3 * size.retained);
    // a closed project's evaluations leave the budget with it
    other.ydoc.destroy();
    expect(evaluationStats(doc).bytes).toBe(0);
  });

  it("drops a project's evaluations from the budget when the project changes", () => {
    evaluationMemory.budget = () => Infinity;
    const doc = linkedCubes(300);
    const size = sceneEvaluationBytes(doc);
    evaluateCached(doc, 1, 'RENDER');
    evaluateCached(doc, 2, 'RENDER');
    expect(evaluationStats(doc)).toMatchObject({ cached: 2, bytes: 2 * size.retained });
    // a change: the evaluations no longer hold, and their heap leaves the budget with them (not only
    // their place in the project's cache, which would leave the budget counting them until evicted)
    const cube = doc.findObjectByName('Cube')!;
    doc.updateObject(cube.id, { location: [1, 2, 3] });
    expect(evaluationStats(doc)).toMatchObject({ cached: 0, bytes: 0 });
    evaluateCached(doc, 1, 'RENDER');
    expect(evaluationStats(doc)).toMatchObject({ cached: 1, bytes: size.retained });
  });

  it('counts the instances that change from frame to frame, the others once', () => {
    evaluationMemory.budget = () => Infinity;
    const still = scatter(2000, false);
    const stillSize = sceneEvaluationBytes(still);
    const a = evaluateCached(still, 1, 'RENDER');
    expect(a.instances).toHaveLength(2000);
    const first = evaluationStats(still).bytes;
    expect(first).toBe(stillSize.retained + 2000 * EVALUATED_INSTANCE_BYTES);
    // a frame that changes nothing shares the instances of the frame before
    expect(evaluateCached(still, 2, 'RENDER').instances).toBe(a.instances);
    expect(evaluationStats(still).bytes - first).toBe(stillSize.retained);

    const moving = scatter(2000, true);
    const size = sceneEvaluationBytes(moving);
    const before = evaluationStats(moving).bytes;
    evaluateCached(moving, 1, 'RENDER');
    const b = evaluateCached(moving, 2, 'RENDER');
    expect(b.instances).toHaveLength(2000);
    expect(evaluationStats(moving).bytes - before).toBe(
      2 * (size.retained + 2000 * EVALUATED_INSTANCE_BYTES),
    );
  });

  it('counts a mesh modifiers make once while frames share it, and every one an animated modifier makes', () => {
    evaluationMemory.budget = () => Infinity;
    const grid = (modifier: string) =>
      scene((op) => {
        op('mesh.primitive_grid_add', { x_subdivisions: 40, y_subdivisions: 40, name: 'Grid' });
        op('object.modifier_add', { type: modifier });
      });
    // Subdivision Surface (viewport levels 1): the same mesh at every frame
    const still = grid('SUBSURF');
    const size = sceneEvaluationBytes(still);
    const mesh = evaluateCached(still, 1, 'VIEWPORT').objects[0].mesh!;
    expect(mesh.faces.length).toBe(4 * 1600);
    evaluateCached(still, 2, 'VIEWPORT');
    expect(evaluationStats(still).bytes).toBe(2 * size.retained + meshBytes(mesh));
    // Wave (time dependent): a mesh of its own at every frame
    const waves = grid('WAVE');
    const waveSize = sceneEvaluationBytes(waves);
    const before = evaluationStats(waves).bytes;
    const m1 = evaluateCached(waves, 1, 'VIEWPORT').objects[0].mesh!;
    const m2 = evaluateCached(waves, 2, 'VIEWPORT').objects[0].mesh!;
    expect(m2).not.toBe(m1);
    expect(evaluationStats(waves).bytes - before).toBe(2 * waveSize.retained + meshBytes(m1) + meshBytes(m2));
  });

  it('refuses an evaluation whose peak does not fit, after dropping the cached ones', () => {
    const doc = linkedCubes(300);
    evaluateCached(doc, 1, 'RENDER');
    expect(evaluationStats(doc).cached).toBe(1);
    const size = sceneEvaluationBytes(doc);
    const asked: [number, number][] = [];
    evaluationMemory.check = (objects, need, release) => {
      asked.push([objects, need]);
      release();
      return 'not evaluated for the test';
    };
    let err: unknown;
    try {
      evaluateCached(doc, 2, 'RENDER');
    } catch (e) {
      err = e;
    }
    expect(isMeshMemoryError(err)).toBe(true);
    expect((err as Error).message).toBe('not evaluated for the test');
    // asked with the scene's objects and its estimated peak; the cached evaluations were dropped
    expect(asked).toEqual([[300, size.peak]]);
    expect(evaluationStats(doc).cached).toBe(0);
    // one the check lets through runs
    evaluationMemory.check = () => null;
    expect(evaluateCached(doc, 2, 'RENDER').objects).toHaveLength(300);
  });

  it("checks evaluations of 32 MB or more against the free heap less the server's reserve", () => {
    // 1 MB free beyond the 256 MB the server keeps for its other work
    let collections = 0;
    let released = 0;
    const check = evaluationCheck({
      heapFree: () => 257 * MB,
      heapLimit: () => 1024 * MB,
      collect: () => collections++,
    });
    const release = () => released++;
    expect(check(6000, 40 * MB, release)).toBe(
      "not evaluated on the server: evaluating the scene's 6,000 objects would need about 40 MB of JavaScript " +
        "heap, and the server's process has 257 MB of its 1,024 MB heap free and keeps 256 MB of it for its " +
        'other work. Delete objects the project no longer needs (a browser editor that has the project open ' +
        'evaluates it in its own memory)',
    );
    // the cached evaluations were dropped and the heap collected before it was refused
    expect([released, collections]).toEqual([1, 1]);
    expect(check(1, OPERATOR_FIXED_BYTES, release)).toMatch(
      /^not evaluated on the server: evaluating the scene's 1 object would/,
    );
    // one that fits runs, without dropping anything
    released = collections = 0;
    const roomy = evaluationCheck({
      heapFree: () => 512 * MB,
      heapLimit: () => 1024 * MB,
      collect: () => collections++,
    });
    expect(roomy(6000, 40 * MB, release)).toBeNull();
    expect([released, collections]).toEqual([0, 0]);
  });

  it('lets smaller evaluations run while garbage fills the heap between collections', () => {
    // a heap of 688 MB with 240 MB free, no collection allowed yet (the last one ran less than a
    // second ago): the frames of a scene of two objects asked for in a row were refused although
    // they needed next to nothing
    let released = 0;
    const check = evaluationCheck({
      heapFree: () => 240 * MB,
      heapLimit: () => 688 * MB,
      collect: () => false,
    });
    expect(check(2, 12_000, () => released++)).toBeNull();
    expect(check(5000, OPERATOR_FIXED_BYTES - 1, () => released++)).toBeNull();
    expect(released).toBe(0);
    // the cache asks with what an evaluation of the scene needs: 1,600 bytes kept per object
    const doc = linkedCubes(300);
    const size = sceneEvaluationBytes(doc);
    expect(size.peak).toBeLessThan(OPERATOR_FIXED_BYTES);
    evaluationMemory.check = check;
    expect(evaluateCached(doc, 1, 'RENDER').objects).toHaveLength(300);
  });
});
