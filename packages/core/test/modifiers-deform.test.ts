import { describe, expect, it } from 'vitest';
import {
  buildTopology,
  compose4,
  createCube,
  createCylinder,
  createGrid,
  createMesh,
  createPlane,
  createUVSphere,
  edgeKey,
  getModifierDef,
  identity4,
  registerBuiltinModifiers,
  rotationFromEuler,
  translation4,
  vertexCount,
  type MeshData,
} from '../src';
import {
  applyModifier,
  boundsOf,
  expectClosedConsistent,
  objectsCtx,
  signedVolume,
  vertexAt,
} from './modifiers-helpers';

const scaled = (m: MeshData, s: [number, number, number]): MeshData => ({
  ...m,
  positions: m.positions.map((v, i) => v * s[i % 3]),
});
const dist = (p: number[], c: number[] = [0, 0, 0]) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);

describe('SMOOTH', () => {
  it('moves vertices toward their neighbours', () => {
    const cube = createCube();
    const r = applyModifier('SMOOTH', cube);
    expect(vertexAt(r, 7).map((c) => +c.toFixed(10))).toEqual(
      [2 / 3, 2 / 3, 2 / 3].map((c) => +c.toFixed(10)),
    );
    expect(r.faces).toBe(cube.faces);
    expect(signedVolume(r)).toBeLessThan(8);
    const xOnly = applyModifier('SMOOTH', cube, { use_y: false, use_z: false });
    expect(vertexAt(xOnly, 7)[0]).toBeCloseTo(2 / 3);
    expect(vertexAt(xOnly, 7).slice(1)).toEqual([1, 1]);
    expect(applyModifier('SMOOTH', cube, { iterations: 0 })).toBe(cube);
    expect(signedVolume(applyModifier('SMOOTH', cube, { iterations: 5 }))).toBeLessThan(signedVolume(r));
  });
});

describe('DISPLACE', () => {
  it('pushes along an axis or the normals by (texture - mid_level) * strength', () => {
    const cube = createCube();
    const up = applyModifier('DISPLACE', cube, { texture_type: 'NONE', direction: 'Z', strength: 2 });
    expect(boundsOf(up).min[2]).toBeCloseTo(0);
    expect(boundsOf(up).max[2]).toBeCloseTo(2);
    const sphere = createUVSphere({ segments: 16, ring_count: 8 });
    const grown = applyModifier('DISPLACE', sphere, { texture_type: 'NONE' });
    for (let i = 0; i < vertexCount(grown); i++) expect(dist(vertexAt(grown, i))).toBeCloseTo(1.5, 1);
    const rgb = applyModifier('DISPLACE', cube, { texture_type: 'NONE', direction: 'RGB_TO_XYZ' });
    expect(vertexAt(rgb, 0)).toEqual([-0.5, -0.5, -0.5]);
  });

  it('uses seeded procedural textures', () => {
    const grid = createGrid({ x_subdivisions: 8, y_subdivisions: 8 });
    const a = applyModifier('DISPLACE', grid, { direction: 'Z' });
    const b = applyModifier('DISPLACE', grid, { direction: 'Z' });
    const c = applyModifier('DISPLACE', grid, { direction: 'Z', seed: 7 });
    expect(a.positions).toEqual(b.positions);
    expect(a.positions).not.toEqual(c.positions);
    const zs = a.positions.filter((_, i) => i % 3 === 2);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(0.05);
    expect(zs.every((z) => Math.abs(z) <= 0.5)).toBe(true);
    // the default cube is displaced too (lattice-aligned coordinates are not a special case)
    expect(applyModifier('DISPLACE', createCube()).positions).not.toEqual(createCube().positions);
    const checker = applyModifier('DISPLACE', grid, { texture_type: 'CHECKER', direction: 'Z' });
    expect(new Set(checker.positions.filter((_, i) => i % 3 === 2).map((z) => Math.abs(z)))).toEqual(
      new Set([0.5]),
    );
    const waves = applyModifier('DISPLACE', grid, { texture_type: 'WAVES', direction: 'Z' });
    expect(waves.positions).not.toEqual(grid.positions);
    const uv = applyModifier('DISPLACE', grid, { direction: 'Z', texture_coords: 'UV' });
    expect(uv.positions).not.toEqual(a.positions);
  });

  it('displaces along global axes in GLOBAL space', () => {
    const rot = rotationFromEuler([Math.PI / 2, 0, 0]); // local +Y points to global +Z
    const r = applyModifier(
      'DISPLACE',
      createCube(),
      { texture_type: 'NONE', direction: 'Z', space: 'GLOBAL' },
      { objectMatrix: rot },
    );
    const v = vertexAt(r, 0);
    expect(v[0]).toBeCloseTo(-1);
    expect(v[1]).toBeCloseTo(-0.5);
    expect(v[2]).toBeCloseTo(-1);
  });
});

describe('CAST', () => {
  it('casts to a sphere, cylinder or cuboid', () => {
    const ellipsoid = scaled(createUVSphere({ segments: 16, ring_count: 8 }), [2, 1, 1]);
    const sph = applyModifier('CAST', ellipsoid, { factor: 1 });
    const d0 = dist(vertexAt(sph, 0));
    for (let i = 0; i < vertexCount(sph); i++) expect(dist(vertexAt(sph, i))).toBeCloseTo(d0, 10);
    const cyl = applyModifier('CAST', ellipsoid, { factor: 1, cast_type: 'CYLINDER' });
    const radial = (i: number) => Math.hypot(vertexAt(cyl, i)[0], vertexAt(cyl, i)[1]);
    for (let i = 1; i < vertexCount(cyl) - 1; i++) {
      expect(radial(i)).toBeCloseTo(radial(1), 10);
      expect(vertexAt(cyl, i)[2]).toBeCloseTo(vertexAt(ellipsoid, i)[2], 12);
    }
    const box = applyModifier('CAST', createUVSphere({ segments: 16, ring_count: 8 }), {
      factor: 1,
      cast_type: 'CUBOID',
    });
    for (let i = 0; i < vertexCount(box); i++)
      expect(Math.max(...vertexAt(box, i).map(Math.abs))).toBeCloseTo(1, 10);
    const halfway = applyModifier('CAST', ellipsoid, { factor: 0.5 });
    expect(dist(vertexAt(halfway, 1))).not.toBeCloseTo(d0, 3);
  });

  it('honours radius limits, axis toggles and a control object', () => {
    const cube = createCube();
    const limited = applyModifier('CAST', scaled(cube, [2, 1, 1]), { factor: 1, radius: 1 });
    expect(limited.positions).toEqual(scaled(cube, [2, 1, 1]).positions);
    expect(applyModifier('CAST', cube, { factor: 0 })).toBe(cube);
    const noZ = applyModifier('CAST', scaled(cube, [2, 1, 1]), { factor: 1, use_z: false });
    for (let i = 0; i < 8; i++) expect(Math.abs(vertexAt(noZ, i)[2])).toBe(1);
    const sphere = createUVSphere({ segments: 12, ring_count: 6 });
    const c = [0.5, 0.2, 0.1];
    const ctl = objectsCtx({
      ctl: { mesh: createMesh(), matrix: translation4(c as [number, number, number]) },
    });
    const moved = applyModifier('CAST', sphere, { factor: 1, object: 'ctl' }, ctl);
    const d = dist(vertexAt(moved, 0), c);
    for (let i = 0; i < vertexCount(moved); i++) expect(dist(vertexAt(moved, i), c)).toBeCloseTo(d, 10);
  });
});

describe('SIMPLE_DEFORM', () => {
  it('twists around the deform axis (with limits)', () => {
    const cube = createCube();
    const r = applyModifier('SIMPLE_DEFORM', cube, { angle: Math.PI / 4 });
    const top = vertexAt(r, 7);
    expect(top[0]).toBeCloseTo(0);
    expect(top[1]).toBeCloseTo(Math.SQRT2);
    expect(top[2]).toBeCloseTo(1);
    const bottom = vertexAt(r, 6);
    expect(bottom[0]).toBeCloseTo(Math.SQRT2);
    expect(bottom[1]).toBeCloseTo(0);
    const limited = applyModifier('SIMPLE_DEFORM', cube, { angle: Math.PI / 4, limits: [0.5, 1] });
    expect(vertexAt(limited, 6)).toEqual([1, 1, -1]);
    expect(vertexAt(limited, 7)[1]).toBeCloseTo(Math.SQRT2);
  });

  it('bends, tapers and stretches', () => {
    const bar = createMesh({ positions: [-Math.PI, 0, 0, 0, 0, 0, Math.PI, 0, 0], looseEdges: [0, 1, 1, 2] });
    const bent = applyModifier('SIMPLE_DEFORM', bar, { deform_method: 'BEND', angle: 0.5 });
    expect(vertexAt(bent, 2)[0]).toBeCloseTo(2);
    expect(vertexAt(bent, 2)[1]).toBeCloseTo(2);
    expect(vertexAt(bent, 0)[0]).toBeCloseTo(-2);
    expect(vertexAt(bent, 1)).toEqual([0, 0, 0]);
    const cube = createCube();
    const taper = applyModifier('SIMPLE_DEFORM', cube, { deform_method: 'TAPER', factor: 1 });
    expect(vertexAt(taper, 7)).toEqual([2, 2, 1]);
    expect(vertexAt(taper, 6)).toEqual([0, 0, -1]);
    const stretch = applyModifier('SIMPLE_DEFORM', cube, { deform_method: 'STRETCH', factor: 1 });
    expect(signedVolume(stretch)).toBeCloseTo(8, 10);
    expect(boundsOf(stretch).max[2]).toBeCloseTo(2);
    expect(boundsOf(stretch).max[0]).toBeCloseTo(Math.SQRT1_2);
    const locked = applyModifier('SIMPLE_DEFORM', cube, { deform_method: 'TAPER', factor: 1, lock_x: true });
    expect(vertexAt(locked, 7)).toEqual([1, 2, 1]);
  });

  it('deforms in the space of an origin object', () => {
    // origin rotated so that its Z axis is the owner's X axis: twisting then happens around X
    const ctx = objectsCtx({ o: { mesh: createMesh(), matrix: rotationFromEuler([0, Math.PI / 2, 0]) } });
    const r = applyModifier('SIMPLE_DEFORM', createCube(), { angle: Math.PI / 4, origin: 'o' }, ctx);
    for (let i = 0; i < 8; i++) expect(vertexAt(r, i)[0]).toBeCloseTo(vertexAt(createCube(), i)[0], 10);
    expect(r.positions).not.toEqual(createCube().positions);
  });
});

describe('WAVE', () => {
  const probe = createMesh({ positions: [0.25, 0, 0, 10, 0, 0, 0, 0.25, 0], faces: [[0, 1, 2]] });

  it('is time dependent and travels outward', () => {
    registerBuiltinModifiers();
    expect(getModifierDef('WAVE')!.timeDependent).toBe(true);
    const f1 = applyModifier('WAVE', probe, {}, { frame: 1 });
    expect(vertexAt(f1, 0)[2]).toBeCloseTo(0.5);
    expect(vertexAt(f1, 2)[2]).toBeCloseTo(0.5);
    const f5 = applyModifier('WAVE', probe, {}, { frame: 5 });
    expect(f5.positions).not.toEqual(f1.positions);
    const single = applyModifier('WAVE', probe, { use_cyclic: false }, { frame: 1 });
    expect(vertexAt(single, 1)[2]).toBe(0);
  });

  it('supports axis waves, normals, falloff and lifetime', () => {
    const grid = createGrid({ x_subdivisions: 10, y_subdivisions: 10, size: 4 });
    const xOnly = applyModifier('WAVE', grid, { use_y: false }, { frame: 3 });
    // waves along X only depend on x
    const zAt = (m: MeshData, x: number) =>
      m.positions.filter((_, i) => i % 3 === 2 && Math.abs(m.positions[i - 2] - x) < 1e-9);
    expect(new Set(zAt(xOnly, 0.4).map((z) => z.toFixed(9))).size).toBe(1);
    const normal = applyModifier('WAVE', createPlane(), { use_normal: true }, { frame: 2 });
    expect(normal.positions).toEqual(applyModifier('WAVE', createPlane(), {}, { frame: 2 }).positions);
    const fall = applyModifier('WAVE', probe, { falloff_radius: 1 }, { frame: 1 });
    expect(vertexAt(fall, 0)[2]).toBeCloseTo(0.5 * 0.75);
    expect(applyModifier('WAVE', probe, { lifetime: 5, damping_time: 2 }, { frame: 20 })).toBe(probe);
  });
});

describe('SMOOTH_BY_ANGLE', () => {
  it('sets smooth shading and marks sharp edges by angle', () => {
    const cube = createCube();
    const r = applyModifier('SMOOTH_BY_ANGLE', cube);
    expect(r.positions).toBe(cube.positions);
    expect(r.faceSmooth.every(Boolean)).toBe(true);
    expect(Object.values(r.edgeAttrs).filter((a) => a.sharp).length).toBe(12);
    const cyl = createCylinder({ vertices: 16 });
    const c = applyModifier('SMOOTH_BY_ANGLE', cyl);
    expect(Object.values(c.edgeAttrs).filter((a) => a.sharp).length).toBe(32);
    const topo = buildTopology(cyl);
    const side = topo.edges.find(
      ([a, b]) => Math.abs(cyl.positions[a * 3 + 2] - cyl.positions[b * 3 + 2]) > 1,
    )!;
    const key = edgeKey(side[0], side[1]);
    expect(c.edgeAttrs[key]?.sharp).toBeFalsy();
    const marked = { ...cyl, edgeAttrs: { [key]: { sharp: true, seam: true } } };
    expect(applyModifier('SMOOTH_BY_ANGLE', marked).edgeAttrs[key]).toEqual({ sharp: true, seam: true });
    expect(applyModifier('SMOOTH_BY_ANGLE', marked, { ignore_sharpness: true }).edgeAttrs[key]).toEqual({
      seam: true,
    });
  });
});

describe('SHRINKWRAP', () => {
  const sphere = createUVSphere({ segments: 32, ring_count: 16 });
  const ctx = (matrix = identity4(), owner = identity4()) =>
    objectsCtx({ target: { mesh: sphere, matrix } }, { objectMatrix: owner });

  it('snaps to the nearest surface point (with offset)', () => {
    const box = createCube({ size: 4 });
    const r = applyModifier('SHRINKWRAP', box, { target: 'target' }, ctx());
    for (let i = 0; i < 8; i++) expect(dist(vertexAt(r, i))).toBeCloseTo(1, 1);
    const off = applyModifier('SHRINKWRAP', box, { target: 'target', offset: 0.1 }, ctx());
    for (let i = 0; i < 8; i++) expect(dist(vertexAt(off, i))).toBeCloseTo(1.1, 1);
    expectClosedConsistent(r);
    // target transforms are taken into account
    const shifted = applyModifier('SHRINKWRAP', box, { target: 'target' }, ctx(translation4([0, 0, 3])));
    for (let i = 0; i < 8; i++) expect(dist(vertexAt(shifted, i), [0, 0, 3])).toBeCloseTo(1, 1);
    const ownerMoved = applyModifier(
      'SHRINKWRAP',
      box,
      { target: 'target' },
      ctx(identity4(), compose4([0, 0, 3], [0, 0, 0], [1, 1, 1])),
    );
    for (let i = 0; i < 8; i++) expect(dist(vertexAt(ownerMoved, i), [0, 0, -3])).toBeCloseTo(1, 1);
  });

  it('projects, snaps to vertices and respects wrap modes', () => {
    const floor = createPlane({ size: 10 });
    const grid = createGrid({ x_subdivisions: 3, y_subdivisions: 3 });
    const lifted = { ...grid, positions: grid.positions.map((v, i) => (i % 3 === 2 ? 2 : v)) };
    const projected = applyModifier(
      'SHRINKWRAP',
      lifted,
      {
        target: 'floor',
        wrap_method: 'PROJECT',
        use_project_z: true,
        use_negative_direction: true,
        use_positive_direction: false,
      },
      objectsCtx({ floor: { mesh: floor, matrix: identity4() } }),
    );
    expect(projected.positions.filter((_, i) => i % 3 === 2).every((z) => Math.abs(z) < 1e-12)).toBe(true);
    const box = createCube({ size: 4 });
    const snapped = applyModifier(
      'SHRINKWRAP',
      box,
      { target: 'target', wrap_method: 'NEAREST_VERTEX' },
      ctx(),
    );
    const targets = new Set<string>();
    for (let i = 0; i < vertexCount(sphere); i++)
      targets.add(
        vertexAt(sphere, i)
          .map((c) => c.toFixed(9))
          .join(),
      );
    for (let i = 0; i < 8; i++)
      expect(
        targets.has(
          vertexAt(snapped, i)
            .map((c) => c.toFixed(9))
            .join(),
        ),
      ).toBe(true);
    const outside = applyModifier('SHRINKWRAP', box, { target: 'target', wrap_mode: 'OUTSIDE' }, ctx());
    expect(outside.positions).toEqual(box.positions);
    const inside = applyModifier('SHRINKWRAP', box, { target: 'target', wrap_mode: 'INSIDE' }, ctx());
    expect(inside.positions).not.toEqual(box.positions);
    expect(applyModifier('SHRINKWRAP', box, {})).toBe(box);
  });
});
