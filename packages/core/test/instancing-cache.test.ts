import { describe, expect, it, vi } from 'vitest';
import {
  MAX_INSTANCES,
  SceneDoc,
  SceneEvaluator,
  createCube,
  createEditorState,
  createGrid,
  createOperatorRegistry,
  encodeFloat32,
  newId,
  type EvaluatedInstance,
  type MeshData,
  type ModifierData,
  type OperatorContext,
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

  it('keeps separate caches for viewport and render evaluations sharing one distribution', () => {
    const { doc } = scene({ count: 200, display_percentage: 50 });
    const evaluator = new SceneEvaluator(doc);
    const s0 = scatterCalls();
    const vp = evaluator.evaluate(1).instances;
    const render = evaluator.evaluate(1, { forRender: true }).instances;
    expect(vp.length).toBeLessThan(render.length);
    expect(render).toHaveLength(200);
    expect(evaluator.evaluate(1).instances).toBe(vp);
    expect(evaluator.evaluate(1, { forRender: true }).instances).toBe(render);
    // the render reuses the viewport's distribution (same mesh content and settings)
    expect(scatterCalls() - s0).toBe(1);
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

// ------------------------------------------------------------------ caches shared between evaluators

function modifier(type: string, params: Record<string, unknown>): ModifierData {
  return {
    id: newId(),
    name: type,
    type,
    show_viewport: true,
    show_render: true,
    show_in_editmode: true,
    show_expanded: true,
    params,
  };
}

function system(settings: Partial<ParticleSettings>, name = 'P') {
  return { id: newId(), name, show_viewport: true, show_render: true, settings };
}

function maxMove(a: EvaluatedInstance[], b: EvaluatedInstance[]): number {
  const before = new Map(a.map((i) => [i.id, i.matrix]));
  let worst = 0;
  for (const i of b) {
    const m = before.get(i.id)!;
    worst = Math.max(worst, Math.hypot(m[12] - i.matrix[12], m[13] - i.matrix[13], m[14] - i.matrix[14]));
  }
  return worst;
}

describe('instancing caches across evaluators', () => {
  it('keeps the viewport cache valid through one-shot evaluations (content, not identity)', () => {
    const doc = SceneDoc.create({ empty: true });
    const rock = meshObject(doc, 'Rock', createCube({ size: 0.1 }));
    const ground = doc.addObject({
      type: 'MESH',
      name: 'Terrain',
      data: doc.addMesh('T', createGrid({ x_subdivisions: 20, y_subdivisions: 20, size: 20 })),
      modifiers: [modifier('SUBSURF', { levels: 1, render_levels: 1 })],
    });
    doc.updateObject(ground, {
      particle_systems: [system({ instance_object: rock, count: 2000, min_distance: 0.05 })],
    });
    const viewport = new SceneEvaluator(doc);
    const first = viewport.evaluate(1).instances;
    expect(first).toHaveLength(2000);
    const s0 = scatterCalls();
    const p0 = placeCalls();
    expect(viewport.evaluate(1).instances).toBe(first);
    // one-shot evaluations (operator reports, exports, MCP queries) get the cached result ...
    expect(new SceneEvaluator(doc).evaluate(1).instances).toBe(first);
    // ... and leave the viewport's cache intact
    expect(viewport.evaluate(1).instances).toBe(first);
    expect(scatterCalls() - s0).toBe(0);
    expect(placeCalls() - p0).toBe(0);
    // renders with the same modifiers reuse the distribution
    expect(new SceneEvaluator(doc).evaluate(1, { forRender: true }).instances).toHaveLength(2000);
    expect(scatterCalls() - s0).toBe(0);
    // a change seen first by a one-shot evaluation is computed once for everybody
    doc.updateObject(ground, {
      particle_systems: [system({ instance_object: rock, count: 2000, min_distance: 0.05, seed: 1 })],
    });
    const changed = new SceneEvaluator(doc).evaluate(1).instances;
    expect(changed).not.toBe(first);
    expect(viewport.evaluate(1).instances).toBe(changed);
    expect(scatterCalls() - s0).toBe(1);
  });

  it('distributes on the rest shape: particles follow shape keys and deforming modifiers', () => {
    const doc = SceneDoc.create({ empty: true });
    const cube = meshObject(doc, 'Cube', createCube({ size: 0.1 }));
    const grid = createGrid({ x_subdivisions: 10, y_subdivisions: 10, size: 10 });
    const emitter = meshObject(doc, 'Ground', grid);
    const meshId = doc.getObject(emitter)!.data!;
    // the shape key lifts the +X half (z += 5·x): the surface moves at most 0.05 · 5 · 5 = 1.25 m below
    const target = grid.positions.slice();
    for (let i = 0; i < target.length; i += 3) if (target[i] > 0) target[i + 2] += 5 * target[i];
    const key = (value: number) =>
      doc.setShapeKeys(meshId, [
        {
          name: 'Lift',
          value,
          slider_min: 0,
          slider_max: 1,
          mute: false,
          relative_key: '',
          data: encodeFloat32(target),
        },
      ]);
    for (const distribution of ['RANDOM', 'JITTERED'] as const) {
      doc.updateObject(emitter, {
        particle_systems: [system({ instance_object: cube, count: 2000, distribution })],
      });
      const ev = new SceneEvaluator(doc);
      key(0.5);
      const a = ev.evaluate(1).instances;
      const s0 = scatterCalls();
      key(0.55); // the next animation frame
      const b = ev.evaluate(1).instances;
      expect(b).toHaveLength(2000);
      expect(maxMove(a, b)).toBeLessThanOrEqual(1.25 + 1e-9);
      expect(scatterCalls() - s0).toBe(0);
      // no history: a fresh evaluation of the same state gives the same instances
      const fresh = new SceneEvaluator(SceneDoc.fromSnapshot(JSON.parse(JSON.stringify(doc.toSnapshot()))));
      expect(fresh.evaluate(1).instances.map((i) => i.matrix)).toEqual(b.map((i) => i.matrix));
    }
    // a subdivision surface on top: distributed on the subdivided rest shape, still riding the surface
    doc.updateObject(emitter, { modifiers: [modifier('SUBSURF', { levels: 1, render_levels: 1 })] });
    const ev = new SceneEvaluator(doc);
    key(0.5);
    const a = ev.evaluate(1).instances;
    const s0 = scatterCalls();
    key(0.55);
    const b = ev.evaluate(1).instances;
    expect(maxMove(a, b)).toBeLessThanOrEqual(1.25 + 1e-9);
    expect(scatterCalls() - s0).toBe(0);
    // the particles lie on the evaluated (subdivided and lifted) surface: inside its height range
    const zs = b.map((i) => i.matrix[14]);
    expect(Math.max(...zs)).toBeGreaterThan(1);
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(-1e-9);
  });

  it('keeps the distribution while deforming modifiers change on a topology-changing stack', () => {
    const doc = SceneDoc.create({ empty: true });
    const cube = meshObject(doc, 'Cube', createCube({ size: 0.1 }));
    const ground = meshObject(doc, 'Ground', createGrid({ x_subdivisions: 6, y_subdivisions: 6, size: 6 }));
    // DISPLACE without a texture lifts the surface by (1 - mid_level) · strength along Z
    const lift = (strength: number) => ({
      ...modifier('DISPLACE', { texture_type: 'NONE', direction: 'Z', strength, mid_level: 0.5 }),
      id: 'lift',
    });
    const subsurf = (levels: number) => ({
      ...modifier('SUBSURF', { levels, render_levels: levels }),
      id: 'sub',
    });
    doc.updateObject(ground, {
      modifiers: [subsurf(1), lift(1)],
      particle_systems: [system({ instance_object: cube, count: 500, distribution: 'RANDOM' })],
    });
    const ev = new SceneEvaluator(doc);
    const a = ev.evaluate(1).instances;
    expect(a).toHaveLength(500);
    const s0 = scatterCalls();
    doc.updateObject(ground, { modifiers: [subsurf(1), lift(3)] });
    const b = ev.evaluate(1).instances;
    expect(scatterCalls() - s0).toBe(0);
    // every particle rides the surface: same x/y, lifted by the change of the displacement (0.5 → 1.5)
    const before = new Map(a.map((i) => [i.id, i.matrix]));
    for (const i of b) {
      const m = before.get(i.id)!;
      expect(i.matrix[12]).toBeCloseTo(m[12], 9);
      expect(i.matrix[13]).toBeCloseTo(m[13], 9);
      expect(i.matrix[14] - m[14]).toBeCloseTo(1, 9);
    }
    // a change of the generative part (the subdivision level) distributes once more
    doc.updateObject(ground, { modifiers: [subsurf(2), lift(3)] });
    expect(ev.evaluate(1).instances).toHaveLength(500);
    expect(scatterCalls() - s0).toBe(1);
  });
});

describe('instancing operators and caches', () => {
  function operators() {
    const doc = SceneDoc.create({ empty: true });
    const reg = createOperatorRegistry();
    const ctx: OperatorContext = {
      doc,
      state: createEditorState(),
      origin: doc.origin,
      source: 'test',
      report: () => {},
    };
    const ok = (id: string, params?: unknown) => {
      const r = reg.run<any>(ctx, id, params);
      if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
      return r.result;
    };
    return { doc, ok };
  }

  it('recompute only the system they change (reports reuse the viewport distributions)', () => {
    const { doc, ok } = operators();
    const rock = meshObject(doc, 'Rock', createCube({ size: 0.1 }));
    for (let i = 0; i < 4; i++) {
      const field = meshObject(
        doc,
        `Field${i}`,
        createGrid({ x_subdivisions: 30, y_subdivisions: 30, size: 60 }),
        [i * 100, 0, 0],
      );
      doc.updateObject(field, {
        particle_systems: [
          system({ instance_object: rock, count: 3000, distribution: 'RANDOM', min_distance: 0.3 }, 'Grass'),
        ],
      });
    }
    const patio = meshObject(
      doc,
      'Patio',
      createGrid({ x_subdivisions: 2, y_subdivisions: 2, size: 2 }),
      [0, 300, 0],
    );
    const viewport = new SceneEvaluator(doc);
    viewport.evaluate(1);
    const s0 = scatterCalls();
    expect(
      ok('object.particle_system_add', { object: patio, settings: { instance_object: 'Rock', count: 10 } }),
    ).toMatchObject({ particles: 10, instances: 10, errors: [] });
    expect(scatterCalls() - s0).toBe(1);
    const r = ok('object.particle_system_update', { object: 'Patio', settings: { seed: 4 } });
    expect(r).toMatchObject({ particles: 10, instances: 10 });
    expect(scatterCalls() - s0).toBe(2);
    // the viewport picks the new result up without distributing again
    expect(viewport.evaluate(1).instances.filter((i) => i.ownerId === patio)).toHaveLength(10);
    expect(scatterCalls() - s0).toBe(2);
    // display_percentage only changes the viewport placement; the full report keeps every particle
    expect(
      ok('object.particle_system_update', { object: 'Patio', settings: { display_percentage: 50 } }),
    ).toMatchObject({ particles: 10 });
    expect(scatterCalls() - s0).toBe(2);
  });
});
