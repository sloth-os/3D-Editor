import { describe, expect, it } from 'vitest';
import {
  compose4,
  createCube,
  createCylinder,
  createIcoSphere,
  createUVSphere,
  csgMeshBoolean,
  eulerCharacteristic,
  getModifierDef,
  identity4,
  meshStats,
  registerBuiltinModifiers,
  translation4,
  type Mat4,
  type MeshData,
} from '../src';
import { makeRandom } from '../src/modifiers/util';
import {
  applyModifier,
  expectClosedConsistent,
  expectValidMesh,
  objectsCtx,
  signedVolume,
} from './modifiers-helpers';

const cube = createCube();

/** Boolean modifier on an owner placed at `ownerMatrix` with the operand at `operandMatrix` (world space). */
function boolean(
  op: string,
  owner: MeshData,
  operand: MeshData,
  ownerMatrix: Mat4,
  operandMatrix: Mat4,
): MeshData {
  return applyModifier(
    'BOOLEAN',
    owner,
    { operation: op, object: 'cutter' },
    objectsCtx({ cutter: { mesh: operand, matrix: operandMatrix } }, { objectMatrix: ownerMatrix }),
  );
}

describe('BOOLEAN', () => {
  // operand overlaps the owner in a 1 × 1.3 × 1.6 box (volume 2.08), using world transforms
  const owner = translation4([5, 0, 0]);
  const cutter = translation4([6, 0.7, 0.4]);

  it('subtracts the operand (closed result, smaller volume)', () => {
    const r = boolean('DIFFERENCE', cube, cube, owner, cutter);
    expectValidMesh(r);
    expectClosedConsistent(r);
    expect(signedVolume(r)).toBeCloseTo(8 - 2.08, 6);
    expect(signedVolume(r)).toBeLessThan(signedVolume(cube));
    // fragments are merged back into n-gons: the notched box has 9 faces
    expect(meshStats(r).faces).toBe(9);
  });

  it('unions and intersects', () => {
    const u = boolean('UNION', cube, cube, owner, cutter);
    expectClosedConsistent(u);
    const vu = signedVolume(u);
    expect(vu).toBeCloseTo(16 - 2.08, 6);
    expect(vu).toBeGreaterThan(8);
    expect(vu).toBeLessThan(16);
    const i = boolean('INTERSECT', cube, cube, owner, cutter);
    expectClosedConsistent(i);
    expect(signedVolume(i)).toBeCloseTo(2.08, 6);
    expect(meshStats(i)).toMatchObject({ vertices: 8, faces: 6 });
  });

  it('handles rotated operands and keeps volumes consistent', () => {
    const rot = compose4([0.3, -0.2, 0.5], [0.4, 0.3, Math.PI / 4], [1, 1, 1]);
    const d = boolean('DIFFERENCE', cube, cube, identity4(), rot);
    const i = boolean('INTERSECT', cube, cube, identity4(), rot);
    const u = boolean('UNION', cube, cube, identity4(), rot);
    for (const m of [d, i, u]) expectClosedConsistent(m);
    expect(signedVolume(d) + signedVolume(i)).toBeCloseTo(8, 6);
    expect(signedVolume(u) + signedVolume(i)).toBeCloseTo(16, 6);
  });

  it('works with curved and hole-punching operands', () => {
    const sphere = createUVSphere({ segments: 16, ring_count: 8, radius: 1.2 });
    const at = translation4([0.8, 0.3, 0.2]);
    const d = boolean('DIFFERENCE', cube, sphere, identity4(), at);
    const i = boolean('INTERSECT', cube, sphere, identity4(), at);
    expectClosedConsistent(d);
    expectClosedConsistent(i);
    expect(signedVolume(d) + signedVolume(i)).toBeCloseTo(8, 5);
    // a cylinder drilled through the cube leaves a closed genus-1 solid
    const drill = createCylinder({ vertices: 16, radius: 0.5, depth: 4 });
    const holed = boolean('DIFFERENCE', cube, drill, identity4(), identity4());
    expectClosedConsistent(holed);
    expect(eulerCharacteristic(holed)).toBe(0);
    const prism = 8 * 0.25 * Math.sin((2 * Math.PI) / 16) * 2;
    expect(signedVolume(holed)).toBeCloseTo(8 - prism, 6);
  });

  it('handles mirrored operand transforms', () => {
    const mirrored = compose4([1, 0.7, 0.4], [0, 0, 0], [-1, 1, 1]);
    const r = boolean('DIFFERENCE', cube, cube, identity4(), mirrored);
    expectClosedConsistent(r);
    expect(signedVolume(r)).toBeCloseTo(8 - 2.08, 6);
  });

  it('is a no-op without an operand and short-circuits disjoint operands', () => {
    expect(applyModifier('BOOLEAN', cube, {})).toBe(cube);
    expect(applyModifier('BOOLEAN', cube, { object: 'missing' })).toBe(cube);
    const far = translation4([10, 0, 0]);
    expect(boolean('DIFFERENCE', cube, cube, identity4(), far)).toBe(cube);
    expect(boolean('INTERSECT', cube, cube, identity4(), far).faces.length).toBe(0);
    expect(signedVolume(boolean('UNION', cube, cube, identity4(), far))).toBeCloseTo(16);
  });

  it('keeps owner materials, assigns slot 0 to operand faces and carries UVs', () => {
    const owned: MeshData = { ...cube, faceMaterials: cube.faces.map(() => 1) };
    const r = boolean('DIFFERENCE', owned, cube, owner, cutter);
    expect(new Set(r.faceMaterials)).toEqual(new Set([0, 1]));
    expect(r.faceMaterials.filter((m) => m === 0).length).toBe(3);
    expect(r.uvs).not.toBeNull();
    expectValidMesh(r);
  });

  it('declares the operand as a dependency', () => {
    registerBuiltinModifiers();
    const def = getModifierDef('BOOLEAN')!;
    expect(def.dependencies!(def.schema.parse({ object: 'abc' }))).toEqual(['abc']);
    expect(def.dependencies!(def.schema.parse({}))).toEqual([]);
  });

  it('stays closed and volume-consistent for random placements', () => {
    const rnd = makeRandom(1234);
    const owners = [
      cube,
      createUVSphere({ segments: 12, ring_count: 6 }),
      applyModifier('TRIANGULATE', applyModifier('SUBSURF', cube, { levels: 1 })),
    ];
    const operands = [
      createCube({ size: 1.2 }),
      createCylinder({ vertices: 12, radius: 0.4, depth: 3 }),
      createIcoSphere({ subdivisions: 1, radius: 0.9 }),
    ];
    for (let trial = 0; trial < 12; trial++) {
      const a = owners[trial % owners.length];
      const b = operands[Math.floor(rnd() * operands.length)];
      const s = 0.6 + rnd();
      const m = compose4(
        [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5],
        [rnd() * 3, rnd() * 3, rnd() * 3],
        [s, s, s],
      );
      const [d, i, u] = (['DIFFERENCE', 'INTERSECT', 'UNION'] as const).map((op) =>
        csgMeshBoolean(a, b, op, { bMatrix: m }),
      );
      for (const r of [d, i, u]) if (r.faces.length) expectClosedConsistent(r);
      const va = signedVolume(a);
      const vb = signedVolume(b) * s ** 3;
      expect(signedVolume(d) + signedVolume(i)).toBeCloseTo(va, 6);
      expect(signedVolume(u) + signedVolume(i)).toBeCloseTo(va + vb, 6);
    }
  });

  it('exposes the CSG kernel for direct use', () => {
    const r = csgMeshBoolean(cube, cube, 'DIFFERENCE', { bMatrix: translation4([1, 0, 0]) });
    expectClosedConsistent(r);
    expect(meshStats(r)).toMatchObject({ vertices: 8, faces: 6 });
    expect(signedVolume(r)).toBeCloseTo(4);
  });
});
