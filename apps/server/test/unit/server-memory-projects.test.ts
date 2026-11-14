import v8 from 'node:v8';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SIMULATION_BYTES_PER_BODY_FRAME,
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createGrid,
  createOperatorRegistry,
  estimateOperator,
  frameInputCacheBytes,
  freeRigidBodyCache,
  projectObjects,
  rigidBodyCacheBytes,
  rigidBodyCachesBytes,
  saveBytes,
  setOperatorMemoryCheck,
  setSimulationMemoryCheck,
  simulationCacheBytes,
  storedMeshBytes,
  type OperatorContext,
  type OperatorMemoryRequest,
} from '@3d-editor/core';
import {
  evaluationCacheBytes,
  freeHeapBytes,
  maxOpenProjectsBytes,
  maxProjectMeshBytes,
  operatorCheck,
  otherOpenProjects,
  projectGrowthRefusal,
  refusedOperatorMessage,
  refusedSimulationMessage,
  serverHeapReserve,
  simulationCheck,
  trackOpenProject,
  trackOpenRoom,
} from '../../src/render/memory';

/*
 * The server's heap holds every open project at once: what they all keep and the largest save among
 * them are held against what it keeps for all of them (render/memory.ts maxOpenProjectsBytes), next to
 * the limit per project; and rigid body simulations are checked before they step. Heaps are injected
 * (the real checks read V8's heap statistics).
 */

const MB = 1024 * 1024;

/** Documents tracked by a test, destroyed after it (a destroyed document leaves the open projects). */
const opened: SceneDoc[] = [];

afterEach(() => {
  setOperatorMemoryCheck(null);
  setSimulationMemoryCheck(null);
  for (const d of opened.splice(0)) d.ydoc.destroy();
});

/** A project document with a grid of n × n quads, tracked as open, named `name`. */
function openProject(name: string, n: number): SceneDoc {
  const doc = SceneDoc.create({ name, empty: true });
  if (n > 0)
    doc.addObject({
      type: 'MESH',
      name: 'Grid',
      data: doc.addMesh('Grid', createGrid({ x_subdivisions: n, y_subdivisions: n })),
    });
  trackOpenProject(doc);
  opened.push(doc);
  return doc;
}

/**
 * A room's document named `name` (transaction origin `{ type: 'server', room }`) with `n` ACTIVE cubes
 * in a row, falling freely, over the rigid body world's frames 1–`end`.
 */
function roomWithBodies(room: string, name: string, n: number, end: number): SceneDoc {
  const doc = new SceneDoc(undefined, { type: 'server', room });
  doc.map('meta').set('name', name);
  opened.push(doc);
  const registry = createOperatorRegistry();
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: () => undefined,
  };
  const steps: [string, object][] = [
    ['mesh.primitive_cube_add', { name: 'Cube' }],
    ['rigidbody.object_add', { type: 'ACTIVE' }],
    ['object.array_place', { objects: ['Cube'], linked: true, count: n, offset: [3, 0, 0] }],
    ['rigidbody.world_set', { frame_start: 1, frame_end: end }],
  ];
  for (const [id, p] of steps) expect(registry.run(ctx, id, p).ok, id).toBe(true);
  return doc;
}

/** What `doc` keeps and what its save takes, as the server counts them. */
function sizes(doc: SceneDoc) {
  const project = projectObjects(doc);
  return {
    stored: storedMeshBytes(doc) + project.bytes,
    save: saveBytes(project.bytes),
    objects: project.objects,
  };
}

/** A request of an operator that adds `added` bytes to `doc`. */
function request(doc: SceneDoc, added: number): OperatorMemoryRequest {
  const s = sizes(doc);
  return {
    operator: 'object.add_mesh_from_data',
    estimate: {
      bytes: 33 * MB,
      faces: 0,
      addedStoredBytes: added,
      addedSaveBytes: 0,
      lower: 'the number of vertices and faces',
    },
    storedBytes: s.stored,
    saveBytes: s.save,
    objects: s.objects,
    doc,
  };
}

const n = (v: number) => Math.round(v).toLocaleString('en-US');
const up = (bytes: number) => n(Math.ceil(bytes / MB));

describe('open projects', () => {
  it('share what the server keeps for all of them: its heap less the reserve and the cached evaluations', () => {
    const limit = 2096 * MB;
    expect(maxOpenProjectsBytes(limit)).toBe(limit - serverHeapReserve(limit) - evaluationCacheBytes(limit));
    // Node's default heap: 1,310 MB for all projects, 786 MB for one
    expect(Math.floor(maxOpenProjectsBytes(limit) / MB)).toBe(1310);
    expect(Math.floor(maxProjectMeshBytes(limit) / MB)).toBe(786);
  });

  it('are refused an operator that would take them all past it, naming the others', () => {
    // a heap of 300 MB: 256 MB reserved, 22 MB per project, 36 MB for all of them
    const limit = 300 * MB;
    const check = operatorCheck({
      heapFree: () => 295 * MB,
      collect: () => undefined,
      heapLimit: () => limit,
    });
    const a = openProject('Alpha', 200);
    const b = openProject('Beta', 200);
    const c = openProject('Gamma', 0);
    const kept = sizes(a).stored + sizes(b).stored;
    expect(kept).toBeGreaterThan(18 * MB);
    // one project alone may take 18 MB more; with the two others open, the third may not
    const added = 18 * MB;
    expect(sizes(c).stored + added).toBeLessThan(maxProjectMeshBytes(limit));
    const req = request(c, added);
    const all = kept + req.storedBytes + added;
    const save = Math.max(sizes(a).save, sizes(b).save, req.saveBytes!);
    expect(all + save).toBeGreaterThan(maxOpenProjectsBytes(limit));
    expect(check(req)).toBe(
      `not run on the server: the open projects' meshes, objects, keyframes and images would then take about ${up(all)} MB ` +
        `of memory, and the largest save among them about ${up(save)} MB more for a moment: ` +
        `${n(Math.ceil(all / MB) + Math.ceil(save / MB))} MB in all, more than the ` +
        `${n(Math.floor(maxOpenProjectsBytes(limit) / MB))} MB the server's process keeps for all open projects ` +
        `(its 300 MB heap less the 256 MB it keeps for its other work and the 7 MB of cached scene evaluations). ` +
        `Other open projects take ${up(kept)} MB of it: 'Alpha' ${up(sizes(a).stored)} MB, 'Beta' ` +
        `${up(sizes(b).stored)} MB. Lower the number of vertices and faces, or delete objects and meshes the ` +
        'projects no longer need (a project nobody has open, no editor and no MCP session, is unloaded after ' +
        'ROOM_IDLE_TTL_SECONDS, default 3600 s)',
    );
    // without the others (closed: their documents destroyed) it runs
    a.ydoc.destroy();
    b.ydoc.destroy();
    expect(otherOpenProjects(c)).toEqual([]);
    expect(check(request(c, added))).toBeNull();
  });

  it('count the largest save among them once', () => {
    const limit = 300 * MB;
    const a = openProject('Alpha', 0);
    // 300 objects: 3.3 MB kept, 9.9 MB more while saved
    for (let i = 0; i < 300; i++) a.addObject({ type: 'EMPTY', name: `E${i}` });
    const b = openProject('Beta', 0);
    for (let i = 0; i < 300; i++) b.addObject({ type: 'EMPTY', name: `E${i}` });
    const others = otherOpenProjects(b);
    expect(others).toEqual([{ id: '', name: 'Alpha', kept: sizes(a).stored, save: sizes(a).save }]);
    // a third project of meshes: kept by all three, and one save (the largest) besides
    const c = openProject('Gamma', 100);
    const room =
      maxOpenProjectsBytes(limit) - sizes(a).stored - sizes(b).stored - sizes(c).stored - sizes(a).save;
    expect(projectGrowthRefusal(c, room - 64 * 1024, 0, { heapLimit: () => limit })).toBeNull();
    expect(projectGrowthRefusal(c, room + 64 * 1024, 0, { heapLimit: () => limit })).toMatch(
      /^the open projects' meshes, objects, keyframes and images would then take about [\d,]+ MB of memory, and the largest save among them about 10 MB more for a moment: [\d,]+ MB in all, more than the 36 MB the server's process keeps for all open projects \(its 300 MB heap less the 256 MB it keeps for its other work and the 7 MB of cached scene evaluations\)\. Other open projects take 7 MB of it: 'Alpha' 4 MB, 'Beta' 4 MB$/,
    );
  });

  it('are counted again after their documents change', () => {
    const a = openProject('Alpha', 0);
    const b = openProject('Beta', 0);
    expect(otherOpenProjects(b)[0].kept).toBe(sizes(a).stored);
    for (let i = 0; i < 100; i++) a.addObject({ type: 'EMPTY', name: `E${i}` });
    expect(sizes(a).objects).toBe(100);
    expect(otherOpenProjects(b)[0]).toMatchObject({ kept: sizes(a).stored, save: sizes(a).save });
  });

  it('answer a change that does not come from an operator by the limit per project first', () => {
    const limit = 300 * MB;
    const doc = openProject('Solo', 100);
    expect(projectGrowthRefusal(doc, 1 * MB, 0, { heapLimit: () => limit })).toBeNull();
    const s = sizes(doc);
    expect(projectGrowthRefusal(doc, 20 * MB, 3 * MB, { heapLimit: () => limit })).toBe(
      `the project's meshes, objects, keyframes and images would then take about ${up(s.stored + 20 * MB)} MB of memory ` +
        `(now ${n(s.stored / MB)} MB with 1 object), and a save of it about ${up(s.save + 3 * MB)} MB more for a moment ` +
        `(3 times what its objects, datablocks and keyframes take, 5 times its images): ` +
        `${n(Math.ceil((s.stored + 20 * MB) / MB) + Math.ceil((s.save + 3 * MB) / MB))} MB in all, more than the 22 MB ` +
        "the server's process keeps for one project (half of its 300 MB heap less the 256 MB it keeps for its other work)",
    );
  });

  it('are the rooms the checks see: an operator run on a room tracks it, other documents only when asked', () => {
    const room = new SceneDoc(undefined, { type: 'server', room: 'p-room' });
    opened.push(room);
    const other = SceneDoc.create({ name: 'Scratch', empty: true });
    opened.push(other);
    const registry = createOperatorRegistry();
    const ctx: OperatorContext = {
      doc: room,
      state: createEditorState(),
      origin: room.origin,
      source: 'test',
      report: () => undefined,
    };
    setOperatorMemoryCheck(
      operatorCheck({ heapFree: () => 900 * MB, collect: () => undefined, heapLimit: () => 2096 * MB }),
    );
    expect(registry.run(ctx, 'mesh.primitive_cube_add', {}).ok).toBe(true);
    trackOpenRoom(other);
    const listed = otherOpenProjects(undefined).map((p) => p.id);
    expect(listed).toContain('p-room');
    expect(otherOpenProjects(undefined).map((p) => p.name)).not.toContain('Scratch');
  });
});

describe('rigid body simulations in the server', () => {
  it('are refused frames whose cache does not fit into the free heap less the reserve', () => {
    const limit = 1024 * MB;
    const check = simulationCheck({
      heapFree: () => 300 * MB,
      collect: () => undefined,
      heapLimit: () => limit,
    });
    const small = {
      bodies: { simulated: 10, kinematic: 0 },
      frame: 250,
      frames: 249,
      bytes: simulationCacheBytes({ simulated: 10, kinematic: 0 }, 249),
    };
    expect(check(small)).toBeNull();
    // 1,000 bodies to frame 20,000: about 1.1 GB of frames
    const bytes = simulationCacheBytes({ simulated: 1000, kinematic: 0 }, 19_999);
    const big = { bodies: { simulated: 1000, kinematic: 0 }, frame: 20_000, frames: 19_999, bytes };
    expect(bytes).toBeGreaterThan(1000 * MB);
    expect(check(big)).toBe(refusedSimulationMessage(big, 300 * MB, limit));
    expect(check(big)).toBe(
      `not simulated on the server: simulating 1,000 rigid bodies to frame 20,000 keeps 19,999 more frames of their poses, ` +
        `about ${up(bytes)} MB, and the server's process has 300 MB of its 1,024 MB heap free and keeps 256 MB of it for its ` +
        "other work. Lower the rigid body world's frame range (rigidbody.world_set frame_end) or the number of rigid bodies " +
        'to simulate it on the server (a browser editor simulates it itself)',
    );
  });

  it('report a refused simulation as the rigid body world problem of the evaluation', () => {
    const doc = SceneDoc.create({ empty: true });
    opened.push(doc);
    const registry = createOperatorRegistry();
    const ctx: OperatorContext = {
      doc,
      state: createEditorState(),
      origin: { type: 'test' },
      source: 'test',
      report: () => undefined,
    };
    for (const [id, p] of [
      ['mesh.primitive_cube_add', {}],
      ['rigidbody.object_add', { type: 'ACTIVE' }],
    ] as const)
      expect(registry.run(ctx, id, p).ok).toBe(true);
    // no heap free beyond the reserve
    setSimulationMemoryCheck(
      simulationCheck({ heapFree: () => 256 * MB, collect: () => undefined, heapLimit: () => 1024 * MB }),
    );
    const ev = new SceneEvaluator(doc).evaluate(200);
    expect(ev.errors.find((e) => e.source === 'rigidbody')?.message).toMatch(
      /^not simulated on the server: simulating 1 rigid body to frame 200 keeps 199 more frames of its pose, about 1 MB, and the server's process has 256 MB of its 1,024 MB heap free/,
    );
  });

  it('count the frames its cache keeps when a simulation continues: the project limit sees them', () => {
    // a heap of 264 MB: 4 MB for one project
    const limit = 264 * MB;
    setSimulationMemoryCheck(
      simulationCheck({ heapFree: () => 263 * MB, collect: () => undefined, heapLimit: () => limit }),
    );
    const doc = roomWithBodies('p-continued', 'Continued', 20, 2000);
    const s = sizes(doc);
    // 900 frames of 20 bodies, 2 MB: they fit
    new SceneEvaluator(doc).evaluate(901);
    const cache = simulationCacheBytes({ simulated: 20, kinematic: 0 }, 900);
    expect(rigidBodyCacheBytes(doc)).toBe(cache);
    // 900 more frames would fit beside what the project keeps without its cache, but not with it
    expect(s.stored + s.save + cache).toBeLessThan(maxProjectMeshBytes(limit));
    expect(s.stored + s.save + 2 * cache).toBeGreaterThan(maxProjectMeshBytes(limit));
    const ev = new SceneEvaluator(doc).evaluate(1801);
    expect(ev.errors.find((e) => e.source === 'rigidbody')?.message ?? 'simulated').toContain(
      `not simulated on the server: simulating 20 rigid bodies to frame 1,801 keeps 900 more frames of their ` +
        `poses, about ${up(cache)} MB, and the project's meshes, objects, keyframes, images and rigid body cache ` +
        `would then take about ${up(s.stored + 2 * cache)} MB of memory (now ${n((s.stored + cache) / MB)} MB with ` +
        `20 objects, ${up(cache)} MB of it its rigid body cache)`,
    );
    expect(rigidBodyCacheBytes(doc)).toBe(cache);
  });

  it('are refused frames that would take their project past what the server keeps for one', () => {
    // a heap of 300 MB: 22 MB for one project
    const limit = 300 * MB;
    setSimulationMemoryCheck(
      simulationCheck({ heapFree: () => 290 * MB, collect: () => undefined, heapLimit: () => limit }),
    );
    const doc = roomWithBodies('p-bodies', 'Bodies', 20, 15_000);
    const s = sizes(doc);
    const bytes = simulationCacheBytes({ simulated: 20, kinematic: 0 }, 14_999);
    const ev = new SceneEvaluator(doc).evaluate(15_000);
    expect(ev.errors.find((e) => e.source === 'rigidbody')?.message).toBe(
      `not simulated on the server: simulating 20 rigid bodies to frame 15,000 keeps 14,999 more frames of their ` +
        `poses, about ${up(bytes)} MB, and the project's meshes, objects, keyframes, images and rigid body cache would ` +
        `then take about ${up(s.stored + bytes)} MB of memory (now ${n(s.stored / MB)} MB with 20 objects), and a save ` +
        `of it about ${up(s.save)} MB more for a moment (3 times what its objects, datablocks and keyframes take, 5 ` +
        `times its images): ${n(Math.ceil((s.stored + bytes) / MB) + Math.ceil(s.save / MB))} MB in all, more than ` +
        `the 22 MB the server's process keeps for one project (half of its 300 MB heap less the 256 MB it keeps for ` +
        "its other work). Lower the rigid body world's frame range (rigidbody.world_set frame_end) or the number of " +
        'rigid bodies to simulate it on the server (a browser editor simulates it itself), or delete objects and ' +
        'meshes the project no longer needs',
    );
    // nothing was stepped; frames that fit are
    expect(rigidBodyCacheBytes(doc)).toBe(0);
    new SceneEvaluator(doc).evaluate(100);
    expect(rigidBodyCacheBytes(doc)).toBe(simulationCacheBytes({ simulated: 20, kinematic: 0 }, 99));
  });

  it("count the frames a project's cache keeps with what it keeps: other projects and its own operators see them", () => {
    const limit = 300 * MB;
    const check = simulationCheck({
      heapFree: () => 290 * MB,
      collect: () => undefined,
      heapLimit: () => limit,
    });
    setSimulationMemoryCheck(check);
    const a = openProject('Alpha', 200);
    const b = openProject('Beta', 200);
    const c = roomWithBodies('p-c', 'Gamma', 3, 500);
    new SceneEvaluator(c).evaluate(100);
    const cache = simulationCacheBytes({ simulated: 3, kinematic: 0 }, 99);
    expect(rigidBodyCacheBytes(c)).toBe(cache);
    // and the objects every frame state of Gamma reads, kept until it changes (core frameInputCacheBytes)
    const input = frameInputCacheBytes(c);
    expect(input).toBeGreaterThan(0);
    expect(otherOpenProjects(a).find((p) => p.id === 'p-c')).toEqual({
      id: 'p-c',
      name: 'Gamma',
      kept: sizes(c).stored + cache + input,
      save: sizes(c).save,
      simulation: cache,
      evaluation: input,
    });
    // a simulation of Gamma the project could keep, but not with Alpha and Beta open
    const req = {
      bodies: { simulated: 10, kinematic: 0 },
      frame: 5000,
      frames: 4999,
      bytes: 18 * MB,
      doc: c,
    };
    const kept = sizes(a).stored + sizes(b).stored;
    const all = kept + sizes(c).stored + cache + input + req.bytes;
    const save = Math.max(sizes(a).save, sizes(b).save, sizes(c).save);
    expect(check(req)).toBe(
      `not simulated on the server: simulating 10 rigid bodies to frame 5,000 keeps 4,999 more frames of their ` +
        `poses, about 18 MB, and the open projects' meshes, objects, keyframes, images and rigid body caches would ` +
        `then take about ${up(all)} MB of memory, and the largest save among them about ${up(save)} MB more for a ` +
        `moment: ${n(Math.ceil(all / MB) + Math.ceil(save / MB))} MB in all, more than the ` +
        `${n(Math.floor(maxOpenProjectsBytes(limit) / MB))} MB the server's process keeps for all open projects (its ` +
        `300 MB heap less the 256 MB it keeps for its other work and the 7 MB of cached scene evaluations). Other ` +
        `open projects take ${up(kept)} MB of it: 'Alpha' ${up(sizes(a).stored)} MB, 'Beta' ${up(sizes(b).stored)} ` +
        "MB. Lower the rigid body world's frame range (rigidbody.world_set frame_end) or the number of rigid bodies " +
        'to simulate it on the server (a browser editor simulates it itself), or delete objects and meshes the ' +
        'projects no longer need (a project nobody has open, no editor and no MCP session, is unloaded after ' +
        'ROOM_IDLE_TTL_SECONDS, default 3600 s)',
    );
    // the frames Gamma's own cache holds are the first it needs: freeing them is no advice for it, but for
    // a simulation of another project
    const d = roomWithBodies('p-d', 'Delta', 10, 5000);
    const other = check({ ...req, doc: d });
    expect(other).toContain(
      `'Gamma' (p-c) ${up(sizes(c).stored + cache + input)} MB (${up(cache)} MB of it its rigid body cache)`,
    );
    expect(other).toMatch(/default 3600 s\), or free their rigid body caches \(rigidbody\.cache_free\)$/);
    // alone, an operator of Gamma counts its cache with what the project keeps, and says it can be freed
    a.ydoc.destroy();
    b.ydoc.destroy();
    const ops = operatorCheck({ heapFree: () => 290 * MB, collect: () => undefined, heapLimit: () => limit });
    const added = maxProjectMeshBytes(limit) - sizes(c).stored - sizes(c).save - cache / 2;
    const r = ops(request(c, added));
    expect(r).toContain(
      `the project's meshes, objects, keyframes, images and rigid body cache would then take about ` +
        `${up(sizes(c).stored + cache + input + added)} MB of memory (now ${n((sizes(c).stored + cache + input) / MB)} MB with 3 ` +
        `objects, ${up(cache)} MB of it its rigid body cache)`,
    );
    expect(r).toMatch(
      /or delete objects and meshes the project no longer needs, or free its rigid body cache \(rigidbody\.cache_free\)$/,
    );
    // freed, it runs
    freeRigidBodyCache(c);
    expect(ops(request(c, added))).toBeNull();
  });

  it('hold the frames cached outside the heap against the free heap of every check, and say so', () => {
    const doc = roomWithBodies('p-falling', 'Falling', 100, 400);
    new SceneEvaluator(doc).evaluate(400);
    const outside = rigidBodyCachesBytes({ outsideHeap: true });
    // 100 poses of 7 numbers a frame: ArrayBuffers V8's heap statistics leave out
    expect(outside).toBeGreaterThanOrEqual(399 * 100 * SIMULATION_BYTES_PER_BODY_FRAME);
    const h = v8.getHeapStatistics();
    expect(Math.abs(h.heap_size_limit - h.used_heap_size - outside - freeHeapBytes())).toBeLessThan(MB);
    const heap = 1024 * MB;
    const req: OperatorMemoryRequest = {
      operator: 'mesh.subdivide',
      estimate: { bytes: 900 * MB, faces: 1000, addedStoredBytes: 0, lower: 'number_cuts' },
      storedBytes: 0,
    };
    const shown = Math.round((300 * MB + outside) / MB);
    expect(refusedOperatorMessage(req, 300 * MB, heap)).toContain(
      `and the server's process has ${n(shown)} MB of its 1,024 MB heap free, less the ${n(outside / MB)} MB its ` +
        'cached rigid body simulations hold outside it, and keeps 256 MB of it for its other work. Lower number_cuts',
    );
    // a closed project's frames are dropped
    doc.ydoc.destroy();
    expect(rigidBodyCachesBytes({ outsideHeap: true })).toBe(0);
    expect(refusedOperatorMessage(req, 300 * MB, heap)).toContain(
      "and the server's process has 300 MB of its 1,024 MB heap free and keeps 256 MB of it for its other work",
    );
  });
});

describe('vertex groups and shape keys in the refusals', () => {
  /** A project with a grid of 60 × 60 quads and an armature of 12 bones, selected to parent the grid to it. */
  function rigged(type: string) {
    const doc = SceneDoc.create({ name: 'Rigged', empty: true });
    opened.push(doc);
    const registry = createOperatorRegistry();
    const state = createEditorState();
    const ctx: OperatorContext = {
      doc,
      state,
      origin: { type: 'test' },
      source: 'test',
      report: () => undefined,
    };
    const run = (id: string, p: object) => expect(registry.run(ctx, id, p).ok, id).toBe(true);
    run('mesh.primitive_grid_add', { name: 'Grid', x_subdivisions: 60, y_subdivisions: 60 });
    run('object.armature_add', { name: 'Rig' });
    run('armature.chain_add', {
      object: 'Rig',
      points: Array.from({ length: 12 }, (_, i) => [i - 6, 0, 0.5]),
    });
    run('object.select', { objects: ['Grid', 'Rig'], active: 'Rig' });
    const estimate = estimateOperator(
      'object.parent_set',
      ctx,
      registry.parseParams('object.parent_set', { type }),
    )!;
    return { doc, ctx, registry, estimate };
  }

  it('name what an operator writes when the free heap refuses it', () => {
    const { estimate } = rigged('ARMATURE_NAME');
    // 12 deforming bones (the armature's first and a chain of 11), a group each: 4 bytes per vertex and group
    expect(estimate.layers).toEqual({ kind: 'vertex groups', bytes: 12 * 4 * 61 * 61 });
    const req: OperatorMemoryRequest = { operator: 'object.parent_set', estimate, storedBytes: 0 };
    expect(refusedOperatorMessage(req, 300 * MB, 1024 * MB)).toBe(
      `not run on the server: it would need about ${n(estimate.bytes / MB)} MB of JavaScript heap to write about 1 MB ` +
        "of vertex groups, and the server's process has 300 MB of its 1,024 MB heap free and keeps 256 MB of it for " +
        'its other work. Lower the vertices of the child meshes or the number of deforming bones (type ARMATURE ' +
        'parents them without vertex groups) to run it on the server (a browser editor runs it in its own memory)',
    );
    // type ARMATURE writes none
    expect(rigged('ARMATURE').estimate?.layers).toBeUndefined();
    const keys: OperatorMemoryRequest = {
      operator: 'object.shape_key_add',
      estimate: { ...estimate, layers: { kind: 'shape keys', bytes: 61 * MB } },
      storedBytes: 0,
    };
    expect(refusedOperatorMessage(keys, 300 * MB, 1024 * MB)).toContain(
      'MB of JavaScript heap to write about 61 MB of shape keys, and',
    );
  });

  it('count their saves six times, saying so only for projects that hold them', () => {
    const { doc, ctx, registry } = rigged('ARMATURE_NAME');
    expect(registry.run(ctx, 'object.parent_set', { type: 'ARMATURE_NAME' }).ok).toBe(true);
    const project = projectObjects(doc);
    expect(project.layers).toBe(12 * 4 * 61 * 61);
    // a heap of 264 MB: 4 MB for one project (and free heap enough for the operator itself)
    setOperatorMemoryCheck(
      operatorCheck({ heapFree: () => 2048 * MB, collect: () => undefined, heapLimit: () => 264 * MB }),
    );
    // what its objects keep three times, the weights (kept with its meshes) six times
    expect(project.save).toBe(saveBytes(project.bytes) + 6 * project.layers);
    const refused = registry.run(ctx, 'mesh.primitive_grid_add', {
      x_subdivisions: 300,
      y_subdivisions: 300,
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain(
      '(3 times what its objects, datablocks and keyframes take, 5 times its images, 6 times its vertex groups and ' +
        'shape keys): ',
    );
    // a project without them: the clause as before
    const plain = openProject('Plain', 10);
    const ctx2: OperatorContext = {
      doc: plain,
      state: createEditorState(),
      origin: { type: 'test' },
      source: 'test',
      report: () => undefined,
    };
    const other = createOperatorRegistry().run(ctx2, 'mesh.primitive_grid_add', {
      x_subdivisions: 300,
      y_subdivisions: 300,
    });
    expect(other.error).toContain(
      '(3 times what its objects, datablocks and keyframes take, 5 times its images): ',
    );
  });
});
