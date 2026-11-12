import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BAKE_BYTES_PER_OBJECT_FRAME,
  BAKE_FCURVE_BYTES,
  BAKE_GARBAGE_GROWTH,
  BAKE_HEAP_BYTES,
  BOUNDED_GROWTH_PARAMETERS,
  DRIVER_ADD_BYTES,
  FCURVE_ADD_BYTES,
  FCURVE_STORED_BYTES,
  FRAME_STATE_BYTES_PER_DRIVER,
  FRAME_STATE_BYTES_PER_KEYFRAME,
  FRAME_STATE_BYTES_PER_OBJECT,
  INSERT_MANY_BYTES_PER_KEYFRAME,
  INSERT_MANY_REWRITE_BYTES,
  KEYFRAME_ADD_BYTES,
  KEYFRAME_COPY_BYTES,
  KEYFRAME_REWRITE_BYTES,
  KEYFRAME_STORED_BYTES,
  OPERATOR_ESTIMATES,
  OPERATOR_FIXED_BYTES,
  RIGID_BODY_BAKE_BYTES,
  RIGID_BODY_BAKE_BYTES_PER_BODY_FRAME,
  LAYER_WRITE_BYTES_PER_BYTE,
  SAVE_BYTES_PER_LAYER_BYTE,
  SHAPE_KEY_BYTES_PER_VERTEX,
  SHAPE_KEY_STORED_BYTES_PER_VERTEX,
  UNESTIMATED_OPERATORS,
  createEditorState,
  createOperatorRegistry,
  estimateOperator,
  frameSamplingBytes,
  frameStateBytes,
  projectStoredBytes,
  saveBytes,
  setOperatorMemoryCheck,
  unestimatedReason,
  type OperatorMemoryRequest,
} from '../src/operators';
import {
  SIMULATION_BYTES_PER_BODY_FRAME,
  SIMULATION_FRAME_BYTES,
  documentSimulationBytes,
  rigidBodyCacheBytes,
  rigidBodyCachesBytes,
  setSimulationMemoryCheck,
  simulationCacheBytes,
  simulationOutsideHeapBytes,
  type SimulationMemoryRequest,
} from '../src/physics';
import { SceneEvaluator } from '../src/eval';
import { SceneDoc } from '../src/doc/scene-doc';
import { decodedMeshBytes } from '../src/mesh/memory';

/*
 * The estimates of operators that write keyframes (operators/memory-keyframes.ts), the list of
 * operators without an estimate and of their parameters that count something, and the check of
 * rigid body simulations (physics/memory.ts).
 */

const here = path.dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  setOperatorMemoryCheck(null);
  setSimulationMemoryCheck(null);
});

function scene() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const state = createEditorState();
  const ctx = { doc, state, origin: { type: 'test' }, source: 'test' as const, report: () => undefined };
  const run = (id: string, params: object = {}) => {
    const r = reg.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id}: ${r.error}`);
    return r;
  };
  const estimate = (id: string, params: object = {}) =>
    estimateOperator(id, ctx, reg.parseParams(id, params));
  return { doc, reg, state, ctx, run, estimate };
}

/** `n` linked cubes in a row, all selected. */
function cubes(n: number) {
  const s = scene();
  s.run('mesh.primitive_cube_add', { name: 'Cube' });
  if (n > 1) s.run('object.array_place', { objects: ['Cube'], linked: true, count: n, offset: [3, 0, 0] });
  s.state.selectedIds = s.doc.objectIds();
  s.state.activeId = s.state.selectedIds[0];
  return s;
}

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  items?: Schema | Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  maxItems?: number;
};

/** Parameter names that say they count something (frames, objects, points, counts, resolutions …). */
const COUNTS =
  /(^|_)(count|frames?|frame_start|frame_end|steps?|segments|cuts|subdivisions|resolution|resolution_u|levels|iterations|points|keys|values|positions|weights|indices|samples|length|width|height|objects|bones|names|offsets|variables|channels)$/;

/** Numeric and list parameters of a JSON schema whose names count something, as dotted paths. */
function countingParameters(s: Schema, at = '', out = new Set<string>()): Set<string> {
  const types = Array.isArray(s.type) ? s.type : [s.type];
  const name = (at.split('.').pop() ?? '').replace(/\[\]/g, '');
  // lists of up to four values are vectors and colors
  const list = types.includes('array') && !(s.maxItems !== undefined && s.maxItems <= 4);
  if ((types.includes('number') || types.includes('integer') || list) && COUNTS.test(name))
    out.add(at.replace(/\[\]/g, ''));
  for (const [k, v] of Object.entries(s.properties ?? {})) countingParameters(v, at ? `${at}.${k}` : k, out);
  if (s.items && !Array.isArray(s.items)) countingParameters(s.items, `${at}[]`, out);
  for (const v of [...(s.anyOf ?? []), ...(s.oneOf ?? [])]) countingParameters(v, at, out);
  return out;
}

describe('operators without an estimate', () => {
  it('are listed by their id, each once, with a reason', () => {
    const reg = createOperatorRegistry();
    const ids = new Set(reg.list().map((d) => d.id));
    const seen = new Set<string>();
    for (const u of UNESTIMATED_OPERATORS) {
      expect(ids.has(u.match), `${u.match} is not an operator`).toBe(true);
      expect(OPERATOR_ESTIMATES[u.match], `${u.match} is estimated`).toBeUndefined();
      expect(seen.has(u.match), `${u.match} is listed twice`).toBe(false);
      expect(u.reason.length).toBeGreaterThan(10);
      seen.add(u.match);
    }
    // a prefix no longer covers operators added later
    expect(unestimatedReason('anim.some_new_bake')).toBeNull();
  });

  it('need an estimate or a reason for every parameter that counts something', () => {
    const reg = createOperatorRegistry();
    const missing: string[] = [];
    const listed = new Set<string>();
    for (const d of reg.describe({ includeUiOnly: true })) {
      if (OPERATOR_ESTIMATES[d.id]) continue;
      for (const p of countingParameters(d.parameters as Schema)) {
        listed.add(`${d.id}.${p}`);
        if (!BOUNDED_GROWTH_PARAMETERS[`${d.id}.${p}`]) missing.push(`${d.id}.${p}`);
      }
    }
    // an operator whose output grows with a parameter is estimated (OPERATOR_ESTIMATES) or says why not
    expect(missing).toEqual([]);
    // and the list names only such parameters of operators without an estimate
    expect(Object.keys(BOUNDED_GROWTH_PARAMETERS).filter((k) => !listed.has(k))).toEqual([]);
    // the bakes to keyframes and inserts of many keyframes are estimated
    for (const id of [
      'anim.bake_transforms',
      'rigidbody.bake_to_keyframes',
      'anim.keyframes_insert_many',
      'anim.keyframe_insert',
    ])
      expect(OPERATOR_ESTIMATES[id], id).toBeDefined();
  });
});

describe('operators that write keyframes', () => {
  it('estimate a bake by objects × frames × channels, and what the project keeps of it', () => {
    const s = cubes(3);
    const e = s.estimate('anim.bake_transforms', { frame_start: 1, frame_end: 100 })!;
    const keys = 3 * 100 * 9;
    expect(e).toMatchObject({
      keyframes: keys,
      addedStoredBytes: KEYFRAME_STORED_BYTES * keys + FCURVE_STORED_BYTES * 27,
      addedSaveBytes: saveBytes(KEYFRAME_STORED_BYTES * keys + FCURVE_STORED_BYTES * 27),
      bytes:
        OPERATOR_FIXED_BYTES +
        KEYFRAME_ADD_BYTES * keys +
        BAKE_FCURVE_BYTES * 27 +
        BAKE_BYTES_PER_OBJECT_FRAME * 3 * 100 +
        // a frame state per sampled frame, which copies the document's three objects
        100 * 3 * FRAME_STATE_BYTES_PER_OBJECT,
      lower:
        'the frame range (frame_start to frame_end, or a larger step) or the number of objects to bake (objects, or the selected objects)',
    });
    // fewer channels, a larger step, fewer objects
    expect(
      s.estimate('anim.bake_transforms', { frame_start: 1, frame_end: 100, channels: ['location'] })
        ?.keyframes,
    ).toBe(keys / 3);
    expect(s.estimate('anim.bake_transforms', { frame_start: 1, frame_end: 100, step: 2 })?.keyframes).toBe(
      keys / 2,
    );
    expect(
      s.estimate('anim.bake_transforms', { objects: ['Cube'], frame_start: 1, frame_end: 100 })?.keyframes,
    ).toBe(keys / 3);
    // clear_parents bakes all three transforms
    expect(
      s.estimate('anim.bake_transforms', {
        frame_start: 1,
        frame_end: 100,
        channels: ['scale'],
        clear_parents: true,
      })?.keyframes,
    ).toBe(keys);
    // the operator refuses more than 10,000 frames by itself
    expect(s.estimate('anim.bake_transforms', { frame_start: 1, frame_end: 10_001 })).toBeNull();
    expect(s.reg.run(s.ctx, 'anim.bake_transforms', { frame_start: 1, frame_end: 10_001 })).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS',
    });
  });

  it('count what a bake keeps as the project counts it afterwards', () => {
    const s = cubes(4);
    const before = projectStoredBytes(s.doc);
    const e = s.estimate('anim.bake_transforms', { frame_start: 1, frame_end: 50 })!;
    s.run('anim.bake_transforms', { frame_start: 1, frame_end: 50 });
    expect(projectStoredBytes(s.doc) - before).toBe(e.addedStoredBytes);
    // baking the same range again replaces its keyframes: the project keeps nothing more, while the
    // curves are rewritten and every frame state copies the 1,800 keyframes
    const again = s.estimate('anim.bake_transforms', { frame_start: 1, frame_end: 50 })!;
    expect(again).toMatchObject({ keyframes: 0, addedStoredBytes: 0, addedSaveBytes: 0 });
    expect(again.bytes - e.bytes).toBe(
      KEYFRAME_REWRITE_BYTES * 4 * 50 * 9 + 50 * FRAME_STATE_BYTES_PER_KEYFRAME * 4 * 50 * 9,
    );
    const kept = projectStoredBytes(s.doc);
    s.run('anim.bake_transforms', { frame_start: 1, frame_end: 50 });
    expect(projectStoredBytes(s.doc)).toBe(kept);
    // frames 26-75: only the 25 frames after 50 are new
    const later = s.estimate('anim.bake_transforms', { frame_start: 26, frame_end: 75 })!;
    expect(later).toMatchObject({
      keyframes: 4 * 25 * 9,
      addedStoredBytes: KEYFRAME_STORED_BYTES * 4 * 25 * 9,
    });
    s.run('anim.bake_transforms', { frame_start: 26, frame_end: 75 });
    expect(projectStoredBytes(s.doc) - kept).toBe(later.addedStoredBytes);
  });

  it('refuse a bake the project cannot keep, with code OUT_OF_MEMORY and what to lower', () => {
    // 500 objects over 5,000 frames (22.5 million keyframes) ended a server on Node's default heap
    const big = cubes(500);
    const e = big.estimate('anim.bake_transforms', { frame_start: 1, frame_end: 5000 })!;
    expect(e.keyframes).toBe(22_500_000);
    expect(e.addedStoredBytes + e.addedSaveBytes!).toBeGreaterThan(10_000 * 1024 * 1024);
    // a host that keeps 786 MB for a project (the server's limit on Node's default heap)
    const LIMIT = 786 * 1024 * 1024;
    const asked: OperatorMemoryRequest[] = [];
    setOperatorMemoryCheck((req) => {
      asked.push(req);
      const need =
        req.storedBytes +
        (req.saveBytes ?? 0) +
        req.estimate.addedStoredBytes +
        (req.estimate.addedSaveBytes ?? 0);
      return need > LIMIT ? `too much: lower ${req.estimate.lower}` : null;
    });
    const s = cubes(100);
    const r = s.reg.run(s.ctx, 'anim.bake_transforms', { frame_start: 1, frame_end: 10_000 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('OUT_OF_MEMORY');
    expect(r.error).toContain('frame range (frame_start to frame_end');
    expect(s.doc.listFCurves()).toEqual([]);
    expect(asked.at(-1)?.estimate.keyframes).toBe(9_000_000);
    // one the project can keep runs
    expect(s.reg.run(s.ctx, 'anim.bake_transforms', { frame_start: 1, frame_end: 10 }).ok).toBe(true);
    expect(s.doc.listFCurves()).toHaveLength(900);
  });

  it('estimate a rigid body bake by its ACTIVE bodies and frames, with the simulation', () => {
    const s = cubes(1);
    s.run('rigidbody.object_add', { type: 'ACTIVE' });
    s.run('object.array_place', { objects: ['Cube'], linked: true, count: 2, offset: [3, 0, 0] });
    s.run('mesh.primitive_plane_add', { name: 'Floor', size: 50, location: [0, 0, -3] });
    s.run('rigidbody.object_add', { type: 'PASSIVE' });
    s.state.selectedIds = s.doc.objectIds();
    // frames 1-50 of the world's default range: the world simulates from frame 1, and its cache
    // keeps the 49 frames after it
    const e = s.estimate('rigidbody.bake_to_keyframes', { frame_start: 1, frame_end: 50 })!;
    const keys = 2 * 50 * 6;
    const frames = simulationCacheBytes({ simulated: 2, kinematic: 0 }, 49);
    expect(e).toMatchObject({
      keyframes: keys,
      addedStoredBytes: KEYFRAME_STORED_BYTES * keys + FCURVE_STORED_BYTES * 12 + frames,
      addedSaveBytes: saveBytes(KEYFRAME_STORED_BYTES * keys + FCURVE_STORED_BYTES * 12),
      simulationBytes: frames,
      bytes:
        OPERATOR_FIXED_BYTES +
        RIGID_BODY_BAKE_BYTES +
        RIGID_BODY_BAKE_BYTES_PER_BODY_FRAME * 2 * 50 +
        BAKE_FCURVE_BYTES * 12 +
        50 * 3 * FRAME_STATE_BYTES_PER_OBJECT +
        frames,
      lower:
        'the frame range (frame_start to frame_end, or a larger step) or the number of rigid bodies to bake (objects, or the selected objects)',
    });
    // a disabled world: the operator fails by itself
    s.run('rigidbody.world_set', { enabled: false });
    expect(s.estimate('rigidbody.bake_to_keyframes', { frame_start: 1, frame_end: 50 })).toBeNull();
  });

  it('count two frame states per sampled frame while the simulation has animated bodies', () => {
    const s = cubes(1);
    s.run('rigidbody.object_add', { type: 'ACTIVE' });
    s.run('mesh.primitive_plane_add', { name: 'Floor', size: 50, location: [0, 0, -3] });
    s.run('rigidbody.object_add', { type: 'PASSIVE' });
    const bake = () =>
      s.estimate('anim.bake_transforms', { objects: ['Cube'], frame_start: 1, frame_end: 50 })!.bytes;
    const terms = () => ({
      one: frameSamplingBytes(s.doc, 50, 1),
      two: frameSamplingBytes(s.doc, 50, 2),
      simulation: documentSimulationBytes(s.doc, 50),
    });
    const still = terms();
    const withStill = bake();
    // the floor animated (kinematic): a sampled frame builds a frame state for the bake and one for the
    // simulation's animated bodies
    s.run('rigidbody.object_settings_set', { objects: ['Floor'], kinematic: true });
    const moving = terms();
    expect(moving.two).toBeGreaterThan(moving.one);
    expect(bake() - moving.two - moving.simulation).toBe(withStill - still.one - still.simulation);
  });

  it('estimate inserts of many keyframes, and of keyframes on many objects', () => {
    const s = cubes(4);
    const frames = Array.from({ length: 1000 }, (_, i) => i + 1);
    const many = { target: 'Cube', path: 'location', index: 0, frames, values: frames };
    const e = s.estimate('anim.keyframes_insert_many', many)!;
    expect(e).toMatchObject({
      keyframes: 1000,
      addedStoredBytes: KEYFRAME_STORED_BYTES * 1000 + FCURVE_STORED_BYTES,
      bytes: OPERATOR_FIXED_BYTES + INSERT_MANY_BYTES_PER_KEYFRAME * 1000 + FCURVE_ADD_BYTES,
      lower: 'the number of frames and values',
    });
    s.run('anim.keyframes_insert_many', many);
    // its F-curve is rewritten with the next keys, unless they replace them
    expect(s.estimate('anim.keyframes_insert_many', many)!.bytes - e.bytes).toBe(
      INSERT_MANY_REWRITE_BYTES * 1000,
    );
    expect(s.estimate('anim.keyframes_insert_many', { ...many, replace: true })!.bytes).toBe(e.bytes);
    // LocRotScale on the four selected objects: 36 channels, one F-curve already there
    const k = s.estimate('anim.keyframe_insert', { type: 'LocRotScale' })!;
    expect(k).toMatchObject({
      keyframes: 36,
      addedStoredBytes: KEYFRAME_STORED_BYTES * 36 + FCURVE_STORED_BYTES * 35,
      bytes:
        OPERATOR_FIXED_BYTES +
        KEYFRAME_ADD_BYTES * 36 +
        FCURVE_ADD_BYTES * 36 +
        KEYFRAME_REWRITE_BYTES * 1000,
      lower: 'the number of selected objects',
    });
    // Available keys the F-curves the objects have
    expect(s.estimate('anim.keyframe_insert', { type: 'Available' })?.keyframes).toBe(1);
  });

  it('estimate a shape key by the vertices of its mesh', () => {
    const s = cubes(1);
    const e = s.estimate('object.shape_key_add', {})!;
    const v = s.doc.meshCounts(s.doc.getObject(s.state.selectedIds[0])!.data!)!.vertices;
    expect(e.addedStoredBytes).toBe(SHAPE_KEY_STORED_BYTES_PER_VERTEX * v);
    // a save copies the key's positions (memory-objects.ts SAVE_BYTES_PER_LAYER_BYTE)
    expect(e.addedSaveBytes).toBe(SAVE_BYTES_PER_LAYER_BYTE * SHAPE_KEY_BYTES_PER_VERTEX * v);
    s.run('object.shape_key_add', {});
    s.run('object.shape_key_add', {});
    // every key of the mesh is copied as the list is stored again (memory-layers.ts)
    expect(s.estimate('object.shape_key_add', {})!.bytes - e.bytes).toBe(
      2 * LAYER_WRITE_BYTES_PER_BYTE * SHAPE_KEY_BYTES_PER_VERTEX * v,
    );
  });
});

describe('the frame states of a bake', () => {
  it('copy the document every sampled frame: its keyframes, objects and drivers, piling up to V8 growing the heap', () => {
    const s = cubes(4);
    s.run('anim.bake_transforms', { frame_start: 1, frame_end: 50 });
    s.run('anim.driver_add', { target: 'Cube', path: 'rotation_euler', index: 2, expression: 'frame' });
    const perFrame =
      FRAME_STATE_BYTES_PER_KEYFRAME * 4 * 50 * 9 +
      FRAME_STATE_BYTES_PER_OBJECT * 4 +
      FRAME_STATE_BYTES_PER_DRIVER;
    expect(frameStateBytes(s.doc)).toBe(perFrame);
    // the copies of every frame, at most what V8 lets the heap grow to over what it keeps meanwhile
    expect(frameSamplingBytes(s.doc, 10)).toBe(10 * perFrame);
    expect(frameSamplingBytes(s.doc, 10, 2)).toBe(20 * perFrame);
    const cap = BAKE_GARBAGE_GROWTH * (BAKE_HEAP_BYTES + projectStoredBytes(s.doc) + perFrame);
    expect(frameSamplingBytes(s.doc, 10_000)).toBe(cap);
    // a bake of one more object samples every frame of its range in a document that holds them
    const solo = s.estimate('anim.bake_transforms', { objects: ['Cube'], frame_start: 51, frame_end: 350 })!;
    const fresh = cubes(4).estimate('anim.bake_transforms', {
      objects: ['Cube'],
      frame_start: 51,
      frame_end: 350,
    })!;
    expect(solo.bytes - fresh.bytes).toBeGreaterThanOrEqual(frameSamplingBytes(s.doc, 300) - 4 * 300 * 1_500);
  });
});

describe('rigid body simulations', () => {
  function bodies(n: number) {
    const s = cubes(1);
    s.run('rigidbody.object_add', { type: 'ACTIVE' });
    if (n > 1) s.run('object.array_place', { objects: ['Cube'], linked: true, count: n, offset: [3, 0, 0] });
    s.run('rigidbody.world_set', { frame_start: 1, frame_end: 500 });
    return s;
  }

  it('ask the installed check before they step, with the frames they will keep', () => {
    const s = bodies(3);
    const asked: SimulationMemoryRequest[] = [];
    setSimulationMemoryCheck((req) => (asked.push(req), null));
    new SceneEvaluator(s.doc).evaluate(100);
    expect(asked).toEqual([
      {
        bodies: { simulated: 3, kinematic: 0 },
        frame: 100,
        frames: 99,
        bytes: 99 * (SIMULATION_FRAME_BYTES + 3 * SIMULATION_BYTES_PER_BODY_FRAME),
        doc: s.doc,
      },
    ]);
    // frames already simulated are not asked for again
    new SceneEvaluator(s.doc).evaluate(150);
    expect(asked[1]).toMatchObject({ frame: 150, frames: 50 });
  });

  it('keep their frames in a cache per document, counted until it is freed or the document destroyed', () => {
    const s = bodies(3);
    const before = rigidBodyCachesBytes();
    const outsideBefore = rigidBodyCachesBytes({ outsideHeap: true });
    new SceneEvaluator(s.doc).evaluate(100);
    const kept = simulationCacheBytes({ simulated: 3, kinematic: 0 }, 99);
    expect(rigidBodyCacheBytes(s.doc)).toBe(kept);
    expect(rigidBodyCachesBytes() - before).toBe(kept);
    // the poses of 3 bodies, 168 bytes a frame, are an ArrayBuffer outside the heap; one body's 56 are not
    expect(rigidBodyCachesBytes({ outsideHeap: true }) - outsideBefore).toBe(
      99 * 3 * SIMULATION_BYTES_PER_BODY_FRAME,
    );
    expect(simulationOutsideHeapBytes({ simulated: 1, kinematic: 0 }, 99)).toBe(0);
    expect(simulationOutsideHeapBytes({ simulated: 1, kinematic: 1 }, 99)).toBe(99 * 128);
    // rigidbody.cache_free drops them; the next evaluation simulates again
    s.run('rigidbody.cache_free');
    expect(rigidBodyCacheBytes(s.doc)).toBe(0);
    new SceneEvaluator(s.doc).evaluate(50);
    expect(rigidBodyCacheBytes(s.doc)).toBe(simulationCacheBytes({ simulated: 3, kinematic: 0 }, 49));
    // a destroyed document (a closed project) drops them
    s.doc.ydoc.destroy();
    expect(rigidBodyCacheBytes(s.doc)).toBe(0);
    expect(rigidBodyCachesBytes()).toBe(before);
  });

  it('are not stepped when the check refuses: evaluations report it, bakes fail with OUT_OF_MEMORY', () => {
    const s = bodies(2);
    setSimulationMemoryCheck(() => 'not simulated on the server: too many frames');
    const ev = new SceneEvaluator(s.doc).evaluate(200);
    expect(ev.errors).toContainEqual({
      source: 'rigidbody',
      message: 'not simulated on the server: too many frames',
    });
    // the bodies stay where they are, unsimulated
    expect(ev.objects.find((o) => o.id === s.doc.objectIds()[0])?.worldMatrix[14]).toBe(0);
    const r = s.reg.run(s.ctx, 'rigidbody.bake_to_keyframes', { frame_start: 1, frame_end: 200 });
    expect(r).toMatchObject({
      ok: false,
      code: 'OUT_OF_MEMORY',
      error: 'not simulated on the server: too many frames',
    });
    expect(s.doc.listFCurves()).toEqual([]);
  });
});

/**
 * Runs `op` in a child process (--trace-gc; operator-memory-child.ts) on `n` objects of `mode`: its
 * estimate and the peak heap between the marks around the run (bytes).
 */
function peak(op: string, n: number, params: object, mode: 'cubes' | 'rigid' | 'baked' | 'keyed') {
  const run = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--trace-gc',
      '--max-old-space-size=4096',
      '--import',
      'tsx',
      path.join(here, 'operator-memory-child.ts'),
      op,
      String(n),
      JSON.stringify(params),
      mode,
    ],
    { encoding: 'utf8', cwd: here, timeout: 25_000 },
  );
  const lines = run.stdout.split('\n');
  const start = lines.findIndex((l) => l.startsWith('#MARK before'));
  const end = lines.findIndex((l) => l.startsWith('#MARK done'));
  expect(start, run.stderr).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const base = Number(lines[start].split(' ')[2]);
  let max = Number(lines[end].split(' ')[2]);
  for (const l of lines.slice(start, end)) {
    const m = /([\d.]+) \([\d.]+\) -> [\d.]+ \([\d.]+\) MB/.exec(l);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const out = JSON.parse(lines.find((l) => l.startsWith('{'))!) as {
    ok: boolean;
    error?: string;
    estimate: { bytes: number };
  };
  expect(out.ok, out.error).toBe(true);
  return { estimate: out.estimate.bytes, peak: (max - base) * 1024 * 1024 };
}

describe('the estimates of bakes hold', () => {
  it('above the peak heap of a bake of 100 objects over 1,000 frames (V8 GC trace in a child process)', () => {
    // 900,000 keyframes: 172–204 MB at the peak measured
    const r = peak('anim.bake_transforms', 100, { frame_start: 1, frame_end: 1000 }, 'cubes');
    expect(r.estimate).toBeGreaterThanOrEqual(r.peak);
    expect(r.estimate).toBeLessThan(r.peak * 3);
  }, 30_000);

  it('above the peak heap of a bake of one object over 300 frames in a document of 2,700 keyframes (V8 GC trace in a child process)', () => {
    // every frame state copies the document's keyframes: 82–98 MB at the peak measured, which the
    // bake's own keyframes (32.8 MB estimated without the copies) did not cover
    const r = peak(
      'anim.bake_transforms',
      10,
      { objects: ['Solo'], frame_start: 1, frame_end: 300 },
      'baked',
    );
    expect(r.estimate).toBeGreaterThanOrEqual(r.peak);
    expect(r.estimate).toBeLessThan(r.peak * 4);
  }, 30_000);

  it('above the peak heap of a bake of one object over 300 frames in a document of 13,500 keyframes (V8 GC trace in a child process)', () => {
    // the frame states' copies (1.4 MB a frame) pile up until V8 collects its old generation, at about
    // BAKE_GARBAGE_GROWTH times what the heap keeps: 172–191 MB at the peak measured
    const r = peak(
      'anim.bake_transforms',
      50,
      { objects: ['Solo'], frame_start: 1, frame_end: 300 },
      'baked',
    );
    expect(r.estimate).toBeGreaterThanOrEqual(1.1 * r.peak);
    expect(r.estimate).toBeLessThan(r.peak * 4);
  }, 30_000);

  it('above the peak heap of 100,000 keyframes inserted between the 100,000 of a curve (V8 GC trace in a child process)', () => {
    // with the server's listener on the document's updates: 64–73 MB at the peak measured
    const r = peak('anim.keyframes_insert_many', 100_000, { __between: true }, 'keyed');
    expect(r.estimate).toBeGreaterThanOrEqual(1.1 * r.peak);
    expect(r.estimate).toBeLessThan(r.peak * 3);
  }, 30_000);

  it('above the peak heap of a rigid body bake of 100 bodies over 200 frames (V8 GC trace in a child process)', () => {
    const r = peak('rigidbody.bake_to_keyframes', 100, { frame_start: 1, frame_end: 200 }, 'rigid');
    expect(r.estimate).toBeGreaterThanOrEqual(r.peak);
    expect(r.estimate).toBeLessThan(r.peak * 4);
  }, 30_000);
});

describe('the decoded size the estimates use', () => {
  it('is that of mesh/memory.ts', () => {
    // a cube of 8 vertices, 6 quads, with a UV layer
    expect(
      decodedMeshBytes({ vertices: 8, faces: 6, corners: 24, uvs: true, colors: false }),
    ).toBeGreaterThan(0);
  });
});

describe('a duplicate of animated objects', () => {
  /** `n` cubes of their own meshes, each with `keys` keyframes on its three location channels and a driver. */
  function animatedCubes(n: number, keys: number) {
    const s = scene();
    const ids: string[] = [];
    s.doc.transact(() => {
      for (let i = 0; i < n; i++) {
        s.run('mesh.primitive_cube_add', { location: [3 * i, 0, 0] });
        const id = s.state.activeId!;
        ids.push(id);
        for (let c = 0; c < 3; c++)
          s.doc.setFCurve({
            target_type: 'object',
            target_id: id,
            path: 'location',
            index: c,
            keyframes: Array.from({ length: keys }, (_, f) => ({
              frame: f + 1,
              value: f,
              interpolation: 'LINEAR',
            })),
          } as never);
        s.doc.setDriver({
          target_type: 'object',
          target_id: id,
          path: 'rotation_euler',
          index: 2,
          type: 'SCRIPTED',
          expression: 'var * 0.5',
          variables: [
            { name: 'var', type: 'SINGLE_PROP', target_type: 'object', target_id: id, path: 'location[0]' },
          ],
        } as never);
      }
    });
    s.state.selectedIds = ids;
    s.state.activeId = ids[0];
    return s;
  }

  it('counts the animation the copies get, as the project counts it afterwards', () => {
    for (const linked of [false, true]) {
      const s = animatedCubes(20, 50);
      // a mesh F-curve the copied meshes get too (linked: false), none of the linked duplicates
      const mesh = s.doc.getObject(s.state.selectedIds[0])!.data!;
      s.doc.setFCurve({
        target_type: 'mesh',
        target_id: mesh,
        path: 'auto_smooth_angle',
        index: 0,
        keyframes: [{ frame: 1, value: 0.5, interpolation: 'LINEAR' }],
      } as never);
      const e = s.estimate('object.duplicate', { linked })!;
      const before = projectStoredBytes(s.doc);
      s.run('object.duplicate', { linked });
      const counted = projectStoredBytes(s.doc) - before;
      expect(Math.abs(e.addedStoredBytes / counted - 1), `linked ${linked}`).toBeLessThan(0.01);
      // 20 objects × 3 F-curves × 50 keyframes, and the mesh's one
      expect(e.keyframes).toBe(3000 + (linked ? 0 : 1));
      expect(e.bytes).toBeGreaterThan(
        OPERATOR_FIXED_BYTES + KEYFRAME_COPY_BYTES * e.keyframes! + 20 * DRIVER_ADD_BYTES,
      );
    }
  });

  it('names what takes most of it: 10,000 objects sharing one mesh are the objects, not the mesh', () => {
    const s = cubes(10_000);
    for (const linked of [false, true]) {
      const e = s.estimate('object.duplicate', { linked })!;
      expect(e.lower, `linked ${linked}`).toBe('the number of selected objects');
    }
    // one large mesh of its own: its copy is what to lower
    const g = scene();
    g.run('mesh.primitive_grid_add', { x_subdivisions: 400, y_subdivisions: 400 });
    expect(g.estimate('object.duplicate', { linked: false })!.lower).toBe(
      'the number or size of the duplicated meshes (or pass linked: true)',
    );
    // much animation on few objects: the animation
    const a = animatedCubes(2, 20_000);
    expect(a.estimate('object.duplicate', { linked: true })!.lower).toBe(
      'the number of selected objects (or their animation)',
    );
  });
});
