import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createOperatorRegistry,
  type OperatorContext,
} from '../src';
import { createCube } from '../src/mesh/primitives';
import { freeRigidBodyCache } from '../src/physics/rigid-body';
import { loc, physicsScene, range, rb, simulate } from './physics-helpers';

// Regression tests for the domino-cascade issues "Rigid-body results differ between rebuilds of the
// same scene: bodies are ordered by their random object ids" and "Rigid bodies thinner than 10 mm
// silently get a thicker collision shape and hover above the ground".

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const reports: string[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'mcp',
    report: (level, message) => reports.push(`${level}: ${message}`),
  };
  const ok = (id: string, params?: unknown) => {
    const r = reg.run<any>(ctx, id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r.result;
  };
  const z = (name: string, frame: number) => {
    freeRigidBodyCache(doc);
    const s = new SceneEvaluator(doc).evaluate(frame);
    return s.byId.get(doc.findObjectByName(name)!.id)!.worldMatrix[14];
  };
  return { doc, ok, reports, z };
}

describe('rigid body solver order', () => {
  /** A row of dominoes whose object ids sort in the given order (and with other names). */
  function dominoes(idOrder: 'ascending' | 'descending', prefix: string) {
    const s = physicsScene();
    s.ground({ friction: 0.6 });
    const box = s.mesh('domino', () => createCube({ size: 1 }));
    const N = 12;
    for (const i of range(0, N - 1)) {
      const id = `${idOrder === 'ascending' ? 'a' : 'z'}${String(idOrder === 'ascending' ? i : N - i).padStart(3, '0')}`;
      s.doc.addObject(
        {
          type: 'MESH',
          name: `${prefix}.${String(i).padStart(3, '0')}`,
          data: box,
          rigid_body: rb('ACTIVE', {
            collision_shape: 'BOX',
            mass: 0.1,
            collision_margin: 0.002,
            friction: 0.6,
          }),
          location: [i * 0.35, 0, 0.5],
          scale: [0.1, 0.5, 1],
          rotation_euler: i === 0 ? [0, 0.25, 0] : [0, 0, 0],
        },
        id,
      );
    }
    s.setWorld({ substeps_per_frame: 10, solver_iterations: 10, frame_end: 120 });
    return s.doc;
  }

  it('simulates identical scenes identically whatever their object ids and names', () => {
    const a = dominoes('ascending', 'Domino');
    const b = dominoes('descending', 'Tile');
    const frames = range(1, 90);
    const ra = simulate(a, frames);
    const rbm = simulate(b, frames);
    // pair the bodies up by their start position
    const byX = (doc: SceneDoc) =>
      doc
        .listObjects()
        .filter((o) => o.rigid_body?.type === 'ACTIVE')
        .sort((p, q) => p.location[0] - q.location[0])
        .map((o) => o.id);
    const ia = byX(a);
    const ib = byX(b);
    let maxDiff = 0;
    for (const f of frames.slice(1)) {
      for (let i = 0; i < ia.length; i++) {
        const pa = loc(ra.get(f)!.get(ia[i])!);
        const pb = loc(rbm.get(f)!.get(ib[i])!);
        maxDiff = Math.max(maxDiff, Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]));
      }
    }
    expect(maxDiff).toBe(0);
    // the cascade itself happened (the last domino fell)
    expect(loc(ra.get(90)!.get(ia[ia.length - 1])!)[2]).toBeLessThan(0.3);
  });
});

describe('thin rigid bodies', () => {
  it('rests a 7.5 mm tile on the ground at its true thickness (no 10 mm minimum)', () => {
    const { ok, reports, z } = setup();
    ok('mesh.primitive_cube_add', { name: 'Ground', size: 1, scale: [4, 4, 0.1], location: [0, 0, -0.05] });
    ok('mesh.primitive_cube_add', {
      name: 'Tile',
      size: 1,
      scale: [0.048, 0.024, 0.0075],
      location: [0, 0, 0.1],
    });
    ok('object.select_all', { action: 'SELECT' });
    ok('object.transform_apply', { location: false, rotation: false, scale: true });
    ok('rigidbody.object_add', { objects: ['Ground'], type: 'PASSIVE', collision_shape: 'BOX' });
    const r = ok('rigidbody.object_add', {
      objects: ['Tile'],
      type: 'ACTIVE',
      collision_shape: 'BOX',
      mass: 0.02,
      collision_margin: 0.001,
    });
    expect(r.objects[0].collision_note).toBeNull();
    expect(reports).toEqual([]);
    expect(z('Tile', 48)).toBeCloseTo(0.00375, 5);
    const d = ok('rigidbody.describe', { frame: 48 });
    expect(d.objects.find((o: { name: string }) => o.name === 'Tile').issues).toEqual([]);
  });

  it('stacks 1.75 mm coins and keeps a 0.3 mm card on a triangle-mesh floor', () => {
    const { ok, z } = setup();
    ok('mesh.primitive_plane_add', { name: 'Floor', size: 4 });
    ok('rigidbody.object_add', { objects: ['Floor'], type: 'PASSIVE' }); // MESH collider
    for (let i = 0; i < 4; i++) {
      ok('mesh.primitive_cylinder_add', {
        name: `Coin${i}`,
        vertices: 24,
        radius: 0.012,
        depth: 0.00175,
        location: [0.001 * i, 0, 0.01 + 0.004 * i],
      });
      ok('rigidbody.object_add', {
        objects: [`Coin${i}`],
        collision_shape: 'CYLINDER',
        mass: 0.007,
        collision_margin: 0.0005,
      });
    }
    // a new object is the only selected one: transform_apply bakes its scale into the mesh
    ok('mesh.primitive_cube_add', {
      name: 'Card',
      size: 1,
      scale: [0.063, 0.088, 0.0003],
      location: [0.3, 0, 0.05],
      rotation: [0.3, 0.2, 0],
    });
    ok('object.transform_apply', { location: false, rotation: false, scale: true });
    ok('rigidbody.object_add', {
      objects: ['Card'],
      collision_shape: 'BOX',
      mass: 0.002,
      collision_margin: 0.0005,
    });
    ok('rigidbody.world_set', { substeps_per_frame: 10, solver_iterations: 10 });
    // each coin lies 1.75 mm above the one below (within the solver's thickness-relative slop)
    for (let i = 0; i < 4; i++)
      expect(Math.abs(z(`Coin${i}`, 60) - (0.000875 + 0.00175 * i))).toBeLessThan(2e-4);
    expect(z('Card', 60)).toBeGreaterThan(0.0001);
    expect(z('Card', 60)).toBeLessThan(0.0002);
  });

  it('reports bodies too thin for the solver and keeps flat floors exact', () => {
    const { ok, reports, z } = setup();
    // a plane floor with a BOX shape: the slab lies behind the plane, so things rest on the plane itself
    ok('mesh.primitive_plane_add', { name: 'Floor', size: 4 });
    const floor = ok('rigidbody.object_add', { objects: ['Floor'], type: 'PASSIVE', collision_shape: 'BOX' });
    expect(floor.objects[0].collision_note).toBeNull();
    ok('mesh.primitive_cube_add', {
      name: 'Tile',
      size: 1,
      scale: [0.048, 0.024, 0.0075],
      location: [0, 0, 0.1],
    });
    ok('object.transform_apply', { location: false, rotation: false, scale: true });
    ok('rigidbody.object_add', {
      objects: ['Tile'],
      collision_shape: 'BOX',
      mass: 0.02,
      collision_margin: 0.001,
    });
    expect(z('Tile', 48)).toBeCloseTo(0.00375, 5);
    // a 0.05 mm sheet of 30 cm is below 0.2 % of its size: simulated thicker, and said so
    ok('mesh.primitive_cube_add', {
      name: 'Sheet',
      size: 1,
      scale: [0.21, 0.297, 0.00005],
      location: [1, 0, 0.1],
    });
    ok('object.transform_apply', { location: false, rotation: false, scale: true });
    reports.length = 0;
    const r = ok('rigidbody.object_add', { objects: ['Sheet'], collision_shape: 'BOX', mass: 0.005 });
    expect(r.objects[0].collision_note).toMatch(/only 0\.05 mm thick.*collides as if 0\.59 mm thick/);
    // the rule as stated: 0.59 mm is 0.2% of the sheet's largest dimension (29.7 cm), not of its half size
    expect(r.objects[0].collision_note).toContain('0.59 mm (0.2% of its largest dimension)');
    expect(reports.join('\n')).toMatch(/WARNING: 'Sheet': the mesh is only 0\.05 mm thick/);
    const d = ok('rigidbody.describe', { frame: 30 });
    expect(d.objects.find((o: { name: string }) => o.name === 'Sheet').issues.join(' ')).toMatch(
      /collides as if 0\.59 mm thick/,
    );
    expect(z('Sheet', 60)).toBeCloseTo(0.000297, 5);
  });

  it('cascades a row of real-size dominoes (48 x 24 x 7.5 mm) in order', () => {
    const { ok, doc } = setup();
    ok('mesh.primitive_cube_add', { name: 'Ground', size: 1, scale: [2, 2, 0.1], location: [0, 0, -0.05] });
    const names = range(0, 11).map((i) => `D${String(i).padStart(2, '0')}`);
    names.forEach((name, i) =>
      ok('mesh.primitive_cube_add', {
        name,
        size: 1,
        scale: [0.0075, 0.024, 0.048],
        location: [i * 0.03, 0, 0.024],
        rotation: i === 0 ? [0, 0.35, 0] : [0, 0, 0],
      }),
    );
    ok('object.select_all', { action: 'SELECT' });
    ok('object.transform_apply', { location: false, rotation: false, scale: true });
    ok('rigidbody.object_add', {
      objects: ['Ground'],
      type: 'PASSIVE',
      collision_shape: 'BOX',
      friction: 0.6,
    });
    ok('rigidbody.object_add', {
      objects: names,
      collision_shape: 'BOX',
      mass: 0.008,
      collision_margin: 0.0005,
    });
    ok('rigidbody.world_set', { substeps_per_frame: 20, solver_iterations: 20 });
    const ev = new SceneEvaluator(doc);
    const fell = new Array<number>(names.length).fill(-1);
    for (let f = 2; f <= 40; f++) {
      const s = ev.evaluate(f);
      names.forEach((n, i) => {
        const m = s.byId.get(doc.findObjectByName(n)!.id)!.worldMatrix;
        if (fell[i] < 0 && m[10] / Math.hypot(m[8], m[9], m[10]) < Math.SQRT1_2) fell[i] = f;
      });
    }
    expect(fell.every((f) => f > 0)).toBe(true);
    for (let i = 1; i < fell.length; i++) expect(fell[i]).toBeGreaterThanOrEqual(fell[i - 1]);
  });
});

describe('rigid body notes and large scenes', () => {
  it('states the minimum thickness rule as it is applied (largest dimension, 10 mm cap)', () => {
    const { ok, reports } = setup();
    // the verifier's sheet: a 2 m cube scaled to 42 x 59.4 cm x 0.1 mm → 0.2% of 59.4 cm = 1.2 mm
    ok('mesh.primitive_cube_add', { name: 'Sheet', scale: [0.21, 0.297, 0.00005], location: [1, 0, 0.1] });
    ok('object.transform_apply', { location: false, rotation: false, scale: true });
    const r = ok('rigidbody.object_add', { objects: ['Sheet'], collision_shape: 'BOX', mass: 0.005 });
    expect(r.objects[0].collision_note).toBe(
      'the mesh is only 0.1 mm thick (Z), below the minimum collision thickness of 1.2 mm (0.2% of its ' +
        'largest dimension): it collides as if 1.2 mm thick',
    );
    // a 6 m plane as a dynamic body: 0.2% would be 12 mm, the cap is 10 mm
    ok('mesh.primitive_plane_add', { name: 'Board', size: 6, location: [0, 0, 1] });
    reports.length = 0;
    const b = ok('rigidbody.object_add', { objects: ['Board'], collision_shape: 'BOX' });
    expect(b.objects[0].collision_note).toBe(
      'flat mesh: simulated as a 10 mm thick slab behind its faces (minimum collision thickness: 0.2% of ' +
        'its largest dimension, at most 10 mm)',
    );
    expect(reports).toContain(`WARNING: 'Board': ${b.objects[0].collision_note}`);
  });

  it('adds and changes rigid bodies of many objects in linear time', () => {
    // the thickness check built a frame state (a pass over the whole scene) per object: 1000 objects
    // took 15 s instead of 0.1 s
    const { ok, doc } = setup();
    ok('mesh.primitive_cube_add', { name: 'D0', size: 0.1, location: [0, 0, 0.05] });
    ok('object.array_place', {
      objects: ['D0'],
      pattern: 'LINE',
      count: 800,
      offset: [0.2, 0, 0],
      linked: true,
    });
    const names = doc
      .listObjects()
      .filter((o) => o.type === 'MESH')
      .map((o) => o.name);
    expect(names).toHaveLength(800);
    let t = performance.now();
    const r = ok('rigidbody.object_add', { objects: names, type: 'ACTIVE', collision_shape: 'BOX' });
    const add = performance.now() - t;
    t = performance.now();
    ok('rigidbody.object_settings_set', { objects: names, mass: 0.5 });
    const set = performance.now() - t;
    expect(r.objects).toHaveLength(800);
    expect(r.objects.every((o: { collision_note: string | null }) => o.collision_note === null)).toBe(true);
    // about 50 ms each now; the quadratic version needed over 5 s for 800 objects
    expect(add).toBeLessThan(2500);
    expect(set).toBeLessThan(2500);
  });
});
