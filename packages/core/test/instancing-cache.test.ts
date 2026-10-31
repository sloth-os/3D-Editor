import { describe, expect, it, vi } from 'vitest';
import {
  MAX_INSTANCES,
  SceneDoc,
  SceneEvaluator,
  createCube,
  createGrid,
  newId,
  type MeshData,
  type ParticleSettings,
  type Vec3,
} from '../src';
import * as sampling from '../src/instancing/sampling';
import * as particles from '../src/instancing/particles';

// Count how often particles are distributed / placed (the real implementations still run).
vi.mock('../src/instancing/sampling', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/instancing/sampling')>();
  return { ...mod, scatterParticles: vi.fn(mod.scatterParticles) };
});
vi.mock('../src/instancing/particles', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/instancing/particles')>();
  return { ...mod, placeParticles: vi.fn(mod.placeParticles) };
});

const scatterCalls = () => vi.mocked(sampling.scatterParticles).mock.calls.length;
const placeCalls = () => vi.mocked(particles.placeParticles).mock.calls.length;

function meshObject(
  doc: SceneDoc,
  name: string,
  mesh: MeshData,
  location: Vec3 = [0, 0, 0],
  collection?: string,
) {
  return doc.addObject({
    type: 'MESH',
    name,
    data: doc.addMesh(name, mesh),
    location,
    ...(collection ? { collection } : {}),
  });
}

function scene(settings: Partial<ParticleSettings>) {
  const doc = SceneDoc.create({ empty: true });
  const rock = meshObject(doc, 'Rock', createCube({ size: 0.1 }), [0, 0, 30]);
  const ground = meshObject(doc, 'Ground', createGrid({ x_subdivisions: 20, y_subdivisions: 20, size: 20 }));
  const ps = newId();
  doc.updateObject(ground, {
    particle_systems: [
      {
        id: ps,
        name: 'Scatter',
        show_viewport: true,
        show_render: true,
        settings: { instance_object: rock, ...settings },
      },
    ],
  });
  const setSettings = (patch: Partial<ParticleSettings>) => {
    const o = doc.getObject(ground)!;
    doc.updateObject(ground, {
      particle_systems: [
        { ...o.particle_systems[0], settings: { ...o.particle_systems[0].settings, ...patch } },
      ],
    });
  };
  return { doc, rock, ground, ps, setSettings };
}

describe('instancing caches', () => {
  it('returns the identical instances while nothing changes and re-places without re-scattering', () => {
    const { doc, rock, ground, setSettings } = scene({ count: 500 });
    const evaluator = new SceneEvaluator(doc);
    const s0 = scatterCalls();
    const p0 = placeCalls();
    const first = evaluator.evaluate(1).instances;
    expect(first).toHaveLength(500);
    expect(scatterCalls() - s0).toBe(1);
    // unchanged: same array and same instance objects, nothing recomputed
    const again = evaluator.evaluate(1);
    expect(again.instances).toBe(first);
    expect(again.instances[0]).toBe(first[0]);
    expect(scatterCalls() - s0).toBe(1);
    expect(placeCalls() - p0).toBe(1);
    // other frames without animation reuse everything as well
    expect(evaluator.evaluate(30).instances).toBe(first);
    // moving the emitter re-places the particles but keeps the distribution
    doc.updateObject(ground, { location: [0, 0, 2], rotation_euler: [0, 0, 1] });
    const moved = evaluator.evaluate(1).instances;
    expect(moved).not.toBe(first);
    expect(moved[0].matrix[14]).toBeCloseTo(2, 9);
    expect(scatterCalls() - s0).toBe(1);
    expect(placeCalls() - p0).toBe(2);
    // moving the (hidden) source object does not affect the placement (its location is not used)
    doc.updateObject(rock, { location: [9, 9, 9] });
    const afterSource = evaluator.evaluate(1).instances;
    expect(afterSource.map((i) => i.matrix)).toEqual(moved.map((i) => i.matrix));
    expect(scatterCalls() - s0).toBe(1);
    // placement-only settings re-place, distribution settings re-scatter
    setSettings({ particle_size: 2 });
    expect(evaluator.evaluate(1).instances[0].matrix[0]).not.toBe(moved[0].matrix[0]);
    expect(scatterCalls() - s0).toBe(1);
    setSettings({ count: 600 });
    expect(evaluator.evaluate(1).instances).toHaveLength(600);
    expect(scatterCalls() - s0).toBe(2);
    // editing the emitter mesh re-scatters
    doc.setMesh(doc.getObject(ground)!.data!, createGrid({ x_subdivisions: 4, y_subdivisions: 4, size: 2 }));
    evaluator.evaluate(1);
    expect(scatterCalls() - s0).toBe(3);
  });

  it('keeps separate caches for viewport and render evaluations', () => {
    const { doc } = scene({ count: 200, display_percentage: 50 });
    const evaluator = new SceneEvaluator(doc);
    const s0 = scatterCalls();
    const vp = evaluator.evaluate(1).instances;
    const render = evaluator.evaluate(1, { forRender: true }).instances;
    expect(vp.length).toBeLessThan(render.length);
    expect(render).toHaveLength(200);
    expect(evaluator.evaluate(1).instances).toBe(vp);
    expect(evaluator.evaluate(1, { forRender: true }).instances).toBe(render);
    expect(scatterCalls() - s0).toBe(2);
  });

  it('scatters 10k instances quickly and re-evaluates from cache', () => {
    const { doc } = scene({
      count: 10_000,
      distribution: 'RANDOM',
      size_random: 0.5,
      phase_factor_random: 2,
    });
    const evaluator = new SceneEvaluator(doc);
    let t = performance.now();
    expect(evaluator.evaluate(1).instances).toHaveLength(10_000);
    const cold = performance.now() - t;
    t = performance.now();
    for (let i = 0; i < 10; i++) evaluator.evaluate(1);
    const warm = (performance.now() - t) / 10;
    expect(cold).toBeLessThan(1500);
    expect(warm).toBeLessThan(50);
  });

  it('caps the number of instances with an error', () => {
    const doc = SceneDoc.create({ empty: true });
    const coll = doc.addCollection({ name: 'Trio' });
    for (const n of ['A', 'B', 'C']) meshObject(doc, n, createCube({ size: 0.01 }), [0, 0, 0], coll);
    const ground = meshObject(doc, 'Ground', createGrid({ x_subdivisions: 2, y_subdivisions: 2, size: 100 }));
    doc.updateObject(ground, {
      particle_systems: [
        {
          id: 'ps',
          name: 'Huge',
          show_viewport: true,
          show_render: true,
          settings: {
            count: 70_000,
            distribution: 'RANDOM',
            instance_type: 'COLLECTION',
            instance_collection: coll,
            use_whole_collection: true,
          },
        },
      ],
    });
    const ev = new SceneEvaluator(doc).evaluate(1, { forRender: true });
    expect(ev.instances).toHaveLength(MAX_INSTANCES);
    expect(ev.errors.map((e) => e.message).join('\n')).toMatch(/instance limit of 200000 reached/);
  });

  it('prunes cache entries of deleted objects and systems', () => {
    const { doc, ground } = scene({ count: 50 });
    const evaluator = new SceneEvaluator(doc);
    expect(evaluator.evaluate(1).instances).toHaveLength(50);
    doc.updateObject(ground, { particle_systems: [] });
    expect(evaluator.evaluate(1).instances).toEqual([]);
    doc.removeObject(ground);
    expect(evaluator.evaluate(1).instances).toEqual([]);
  });
});
