import { afterEach, describe, expect, it } from 'vitest';
import {
  GENERATOR_LOWER,
  createEditorState,
  createOperatorRegistry,
  estimateOperator,
  generatorFaces,
  setOperatorMemoryCheck,
  type OperatorContext,
  type OperatorMemoryRequest,
} from '../src/operators';
import { MAX_GENERATED_FACES } from '../src/generate';
import { SceneDoc } from '../src/doc/scene-doc';

/*
 * The generators (object.generate_*) run in the server's own process for MCP tools, which refuses
 * an operator whose estimated peak heap does not fit (operators/memory.ts). Their estimates count
 * the faces each generator builds from its parameters (operators/memory-generators.ts): a default
 * tree of 15,926 faces must not be estimated as the 1,000,000 faces a generator may build at most
 * (1.3 GB), which refused every one of them on servers with less than about 1.6 GB of free heap.
 */

const MB = 1024 * 1024;

afterEach(() => setOperatorMemoryCheck(null));

const registry = createOperatorRegistry();
const generators = registry
  .list()
  .map((d) => d.id)
  .filter((id) => id.startsWith('object.generate_'));

function context(): OperatorContext {
  return {
    doc: SceneDoc.create({ empty: true }),
    state: createEditorState(),
    origin: { type: 'test' },
    source: 'test',
    report: () => undefined,
  };
}

/** The faces generator `id` builds with `params`, and its estimate. */
function generate(id: string, params: Record<string, unknown>) {
  const ctx = context();
  const estimate = estimateOperator(id, ctx, registry.parseParams(id, params))!;
  const res = registry.run(ctx, id, params);
  expect(res.ok, `${id} ${JSON.stringify(params)}: ${res.error}`).toBe(true);
  return { faces: (res.result as { faces: number }).faces, estimate };
}

// a deterministic stream of random numbers
let seed = 11;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const real = (a: number, b: number) => a + rnd() * (b - a);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const points = (n: number, span: number, z: boolean) =>
  Array.from({ length: n }, () =>
    z ? [real(-span, span), real(-span, span), real(-1, 1)] : [real(-span, span), real(-span, span)],
  );

/** Random parameters of the generators whose size the estimate counts (kept small for speed). */
const RANDOM: Record<string, () => Record<string, unknown>> = {
  tree: () => ({
    style: pick(['DECIDUOUS', 'DECIDUOUS', 'CONIFER', 'PALM']),
    branch_levels: int(1, 3),
    branches: int(1, 8),
    leaf_density: pick([0, 1, real(0, 1)]),
    resolution: int(3, 24),
    seed: int(0, 999),
  }),
  fence: () => ({
    points: rnd() < 0.3 ? null : points(int(2, 12), 15, rnd() < 0.5),
    closed: rnd() < 0.3,
    style: pick(['RAIL', 'PICKET']),
    rails: int(1, 8),
    post_spacing: real(0.5, 5),
    picket_width: real(0.02, 0.3),
    picket_gap: real(0, 0.2),
    length: real(1, 40),
  }),
  spring: () => ({ turns: real(0.25, 20), resolution: int(6, 64), wire_segments: int(3, 24) }),
  pipe: () => ({
    points: points(int(2, 30), 10, true),
    segments: int(3, 32),
    bend_radius: rnd() < 0.3 ? 0 : real(0, 2),
    bend_segments: int(1, 12),
    thickness: rnd() < 0.5 ? 0 : 0.05,
    cyclic: rnd() < 0.3,
    radius: 0.1,
  }),
  building: () => ({
    floors: int(1, 12),
    width: real(2, 60),
    depth: real(2, 60),
    floor_height: real(2, 5),
    window_cols: rnd() < 0.4 ? null : int(0, 20),
    window_cols_side: rnd() < 0.4 ? null : int(0, 20),
    window_rows: int(1, 3),
    door: rnd() < 0.7,
    roof: pick(['FLAT', 'GABLE', 'HIP']),
  }),
  arch: () => ({ segments: int(4, 256), style: pick(['ROUND', 'POINTED']), height: real(0.5, 10) }),
  terrain: () => ({ subdivisions: int(1, 60), solid: rnd() < 0.5 }),
  blob: () => ({ resolution: int(8, 32), count: int(1, 64), size: real(0.5, 5), seed: int(0, 999) }),
  cloud: () => ({
    resolution: int(8, 32),
    puffs: int(1, 64),
    size: [real(1, 300), real(1, 100), real(0.5, 30)],
    seed: int(0, 999),
  }),
};

describe('memory estimates of the generators', () => {
  it('count at least the faces each generator builds, from its parameters', () => {
    for (const [kind, random] of Object.entries(RANDOM))
      for (let i = 0; i < 6; i++) {
        const params = random();
        const { faces, estimate } = generate(`object.generate_${kind}`, params);
        expect(estimate.faces, `${kind} ${JSON.stringify(params)}`).toBeGreaterThanOrEqual(faces);
      }
  });

  it('stay near what the generators build at their defaults', () => {
    for (const id of generators) {
      const { faces, estimate } = generate(id, {});
      expect(estimate.faces, id).toBeGreaterThanOrEqual(faces);
      // the counted ones within 7 times what they build (blob and cloud: 4.7 and 6.5), the
      // others by their largest measured result
      expect(estimate.faces, id).toBeLessThan(Math.max(7 * faces, 81_000));
      expect(estimate.bytes, id).toBeLessThan(150 * MB);
      expect(estimate.lower, id).toBe(GENERATOR_LOWER[id.slice('object.generate_'.length)]);
    }
  });

  it('let every generator run at its defaults where 300 MB of heap fit', () => {
    const asked: OperatorMemoryRequest[] = [];
    setOperatorMemoryCheck((req) => {
      asked.push(req);
      return req.estimate.bytes > 300 * MB ? `${req.operator} refused` : null;
    });
    for (const id of generators) expect(registry.run(context(), id, {}), id).toMatchObject({ ok: true });
    expect(asked.map((r) => r.operator).sort()).toEqual([...generators].sort());
  });

  it('take the most a generator builds when the parameters ask for more', () => {
    // a tree of 4 levels of 12 branches would have about 10 million faces: its generator refuses
    // more than MAX_GENERATED_FACES by itself, the estimate stops there
    const p = registry.parseParams('object.generate_tree', {
      branch_levels: 4,
      branches: 12,
      resolution: 64,
    });
    expect(generatorFaces('tree', p as Record<string, unknown>)).toBeGreaterThan(MAX_GENERATED_FACES);
    expect(estimateOperator('object.generate_tree', context(), p)!.faces).toBe(MAX_GENERATED_FACES);
  });
});
