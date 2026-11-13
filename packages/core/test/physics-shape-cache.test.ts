import { describe, expect, it, vi } from 'vitest';
import { createGrid } from '../src/mesh/primitives';
import { RigidBodySimulator, freeRigidBodyCache } from '../src/physics/rigid-body';
import { Simulation, shapeKey } from '../src/physics/simulation';
import { worldParams } from '../src/physics/settings';
import { hostOf, physicsScene, rb, simulate } from './physics-helpers';

// counts collision shape builds (the simulation imports the counted function)
const builds = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/physics/shapes', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/physics/shapes')>();
  return {
    ...mod,
    buildCollisionShape: (...args: Parameters<typeof mod.buildCollisionShape>) => {
      builds.count++;
      return mod.buildCollisionShape(...args);
    },
  };
});

function scene() {
  const s = physicsScene();
  const grid = s.mesh('Grid', () => createGrid({ x_subdivisions: 24, y_subdivisions: 24, size: 20 }));
  const ground = s.add('Ground', grid, rb('PASSIVE')); // MESH shape: triangulation, welding, BVH
  const a = s.add('A', s.cube(1), rb('ACTIVE'), { location: [0, 0, 2] });
  const b = s.add('B', s.cube(1), rb('ACTIVE'), { location: [3, 0, 2] }); // same shape as A
  const ball = s.add('Ball', s.sphere(0.5), rb('ACTIVE'), { location: [-3, 0, 2] });
  return { ...s, ground, a, b, ball };
}

describe('collision shape reuse (content-keyed)', () => {
  it('rebuilds only the shapes whose inputs changed when the simulation restarts', () => {
    const s = scene();
    freeRigidBodyCache(s.doc);
    const sim = new RigidBodySimulator();
    const host = hostOf(s.doc);
    const step = () => {
      builds.count = 0;
      const out = sim.evaluate(s.doc, 20, host);
      expect(out).not.toBeNull();
      return builds.count;
    };
    // ground, one cube shape shared by A and B, the ball
    expect(step()).toBe(3);
    // settings, transforms and new bodies with known shapes rebuild nothing
    s.doc.updateObject(s.a, { rigid_body: rb('ACTIVE', { friction: 0.9 }) });
    expect(step()).toBe(0);
    s.doc.updateObject(s.b, { location: [2, 1, 2] });
    expect(step()).toBe(0);
    s.add('C', s.cube(1), rb('ACTIVE'), { location: [0, 3, 2] });
    expect(step()).toBe(0);
    // a different shape type is built once; switching back finds the previous shape again
    s.doc.updateObject(s.ground, { rigid_body: rb('PASSIVE', { collision_shape: 'BOX' }) });
    expect(step()).toBe(1);
    s.doc.updateObject(s.ground, { rigid_body: rb('PASSIVE') });
    expect(step()).toBe(0);
    // removed and re-added (undo), also when no rigid body was left in between
    const saved = s.doc.getObject(s.ball)!.rigid_body!;
    s.doc.updateObject(s.ball, { rigid_body: null });
    expect(step()).toBe(0);
    s.doc.updateObject(s.ball, { rigid_body: saved });
    expect(step()).toBe(0);
    const bodies = s.doc.listObjects().filter((o) => o.rigid_body);
    for (const o of bodies) s.doc.updateObject(o.id, { rigid_body: null });
    builds.count = 0;
    expect(sim.evaluate(s.doc, 20, host)).toBeNull();
    for (const o of bodies) s.doc.updateObject(o.id, { rigid_body: o.rigid_body });
    expect(step()).toBe(0);
    // a new scale or new mesh content is a new shape
    s.doc.updateObject(s.a, { scale: [1, 1, 2] });
    expect(step()).toBe(1);
    // freeing the cache (rigidbody.cache_free) starts from scratch
    freeRigidBodyCache(s.doc);
    expect(step()).toBe(4);
  });

  it('gives exactly the results of a fresh simulation', () => {
    const s = scene();
    const frames = [5, 20, 40];
    simulate(s.doc, frames);
    // edits that restart the simulation with reused shapes
    const sim = new RigidBodySimulator();
    const host = hostOf(s.doc);
    sim.evaluate(s.doc, 40, host);
    s.doc.updateObject(s.a, { rigid_body: rb('ACTIVE', { restitution: 0.5 }) });
    s.doc.updateObject(s.ball, { location: [-2, 0.5, 3] });
    const reused = frames.map((f) => sim.evaluate(s.doc, f, host));
    const fresh = simulate(s.doc, frames); // frees the cache first: every shape is rebuilt
    frames.forEach((f, i) => expect(reused[i]).toEqual(fresh.get(f)));
  });

  it('keys shapes by mesh content, shape type, dynamics and exact scale', () => {
    const s = scene();
    const mesh = s.doc.getMesh(s.doc.getObject(s.a)!.data!)!;
    const same = s.doc.getMesh(s.doc.getObject(s.b)!.data!)!;
    const active = rb('ACTIVE');
    expect(shapeKey(mesh, active, [1, 1, 1])).toBe(shapeKey(same, active, [1, 1, 1]));
    expect(shapeKey(mesh, active, [1, 1, 1])).not.toBe(shapeKey(mesh, active, [1, 1, 1 + 1e-15]));
    expect(shapeKey(mesh, active, [1, 1, 1])).not.toBe(
      shapeKey(mesh, rb('ACTIVE', { collision_shape: 'BOX' }), [1, 1, 1]),
    );
    // MESH builds a triangle mesh for animated / passive bodies, a hull for dynamic ones
    const meshShape = rb('ACTIVE', { collision_shape: 'MESH' });
    expect(shapeKey(mesh, meshShape, [1, 1, 1])).not.toBe(
      shapeKey(mesh, { ...meshShape, kinematic: true }, [1, 1, 1]),
    );
    const sphere = s.doc.getMesh(s.doc.getObject(s.ball)!.data!)!;
    expect(shapeKey(mesh, active, [1, 1, 1])).not.toBe(shapeKey(sphere, active, [1, 1, 1]));
    // a simulation built from another one shares the unchanged shape objects
    const params = worldParams(s.doc.getScene());
    const tf = hostOf(s.doc).transformsAt(params.frameStart);
    const inputs = () =>
      s.doc
        .listObjects()
        .filter((o) => o.rigid_body)
        .map((o) => ({
          id: o.id,
          rb: o.rigid_body!,
          matrix: tf.get(o.id) ?? null,
          mesh: s.doc.getMesh(o.data!),
        }));
    const first = new Simulation(inputs(), params);
    const second = new Simulation(inputs(), params, { reuse: first });
    second.bodies.forEach((b, i) => expect(b.shape).toBe(first.bodies[i].shape));
    expect(second.shapes.size).toBe(3);
  });
});
