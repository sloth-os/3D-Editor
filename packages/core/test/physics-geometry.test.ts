import { describe, expect, it } from 'vitest';
import { convexHull } from '../src/physics/quickhull';
import {
  boxMass,
  capsuleMass,
  coneMass,
  cylinderMass,
  polyhedronMass,
  sphereMass,
} from '../src/physics/mass';
import {
  minHalfExtent,
  boxPolyhedron,
  buildCollisionShape,
  cuboidFrame,
  type Polyhedron,
  boundingRadius,
  polySupport,
  supportCore,
  supportingFace,
  type Shape,
} from '../src/physics/shapes';
import { epa, gjk, type SupportFn } from '../src/physics/gjk';
import { collidePolyhedra, transformPolyhedron } from '../src/physics/sat';
import { collide, type CollisionPose } from '../src/physics/narrowphase';
import { TriangleBVH } from '../src/physics/bvh';
import {
  MAX_CLIP_VERTICES,
  clipFeatures,
  reduceManifold,
  simplifyPolygon,
  type ContactCandidate,
} from '../src/physics/manifold';
import {
  decomposeRigid,
  mat3ToQuat,
  mulMat3,
  mulMat3TVec,
  mulMat3Vec,
  quatToMat3,
  slerpQ,
  transpose3,
  type Mat3,
} from '../src/physics/vmath';
import { closestPointOnTriangle, collideBoxes, collideSphereBox } from '../src/physics/boxes';
import {
  createCone,
  createCube,
  createCylinder,
  createGrid,
  createIcoSphere,
  createPlane,
  createUVSphere,
} from '../src/mesh/primitives';
import { createMesh } from '../src/mesh/types';
import { compose4 } from '../src/math/mat4';
import { quatFromEuler } from '../src/math/quat';
import type { Vec3 } from '../src/math/types';

const I3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function pose(shape: Shape, p: Vec3 = [0, 0, 0], euler: Vec3 = [0, 0, 0]): CollisionPose {
  return {
    shape,
    px: p[0],
    py: p[1],
    pz: p[2],
    R: quatToMat3(quatFromEuler(euler)),
    boundingRadius: boundingRadius(shape),
  };
}

function shapeOf(
  type: Parameters<typeof buildCollisionShape>[0],
  mesh = createCube({ size: 2 }),
  dynamic = true,
): Shape {
  const b = buildCollisionShape(type, mesh, [1, 1, 1], { dynamic });
  if ('error' in b) throw new Error(b.error);
  return b.shape;
}

const cubePts = (h = 1): number[] => {
  const out: number[] = [];
  for (let i = 0; i < 8; i++) out.push(i & 1 ? h : -h, i & 2 ? h : -h, i & 4 ? h : -h);
  return out;
};

describe('convex hull (quickhull)', () => {
  it('merges coplanar triangles: a cube gives 6 quads with outward normals', () => {
    const pts = [...cubePts(), 0, 0, 0, 0.5, 0.2, -0.3]; // interior points are dropped
    const h = convexHull(pts)!;
    expect(h.dimension).toBe(3);
    expect(h.points.length / 3).toBe(8);
    expect(h.faces.length).toBe(6);
    for (const f of h.faces) expect(f.length).toBe(4);
    h.normals.forEach((n, i) => {
      // every vertex is on or behind every face plane
      for (let v = 0; v < 8; v++)
        expect(
          n[0] * h.points[v * 3] + n[1] * h.points[v * 3 + 1] + n[2] * h.points[v * 3 + 2] - h.offsets[i],
        ).toBeLessThan(1e-9);
      expect(Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2])).toBeCloseTo(1, 9);
    });
  });

  it('contains every input point of a random cloud and is deterministic', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const pts: number[] = [];
    for (let i = 0; i < 500; i++) pts.push(rnd(), rnd() * 0.5, rnd() * 2);
    const h = convexHull(pts)!;
    expect(h.dimension).toBe(3);
    for (let i = 0; i < pts.length; i += 3)
      h.normals.forEach((n, f) => {
        expect(n[0] * pts[i] + n[1] * pts[i + 1] + n[2] * pts[i + 2] - h.offsets[f]).toBeLessThan(1e-7);
      });
    // Euler characteristic of a closed convex polyhedron
    const edges = new Set<string>();
    for (const f of h.faces) f.forEach((a, k) => edges.add([a, f[(k + 1) % f.length]].sort().join(',')));
    expect(h.points.length / 3 - edges.size + h.faces.length).toBe(2);
    expect(convexHull(pts)).toEqual(h);
  });

  it('simplifies large hulls to an optional vertex budget, staying inside the exact hull', () => {
    const sphere = createUVSphere({ segments: 64, ring_count: 32, radius: 1 });
    const h = convexHull(sphere.positions, 64)!;
    expect(h.points.length / 3).toBeLessThanOrEqual(64);
    for (let i = 0; i < h.points.length; i += 3)
      expect(Math.hypot(h.points[i], h.points[i + 1], h.points[i + 2])).toBeLessThanOrEqual(1 + 1e-6);
    const mp = polyhedronMass(h.points, h.faces)!;
    expect(mp.volume).toBeGreaterThan(0.85 * (4 / 3) * Math.PI);
  });

  it('reports degenerate inputs by dimension', () => {
    expect(convexHull([])).toBeNull();
    expect(convexHull([1, 2, 3, 1, 2, 3])!.dimension).toBe(0);
    expect(convexHull([0, 0, 0, 1, 1, 1, 2, 2, 2, 0.5, 0.5, 0.5])!.dimension).toBe(1);
    const flat = convexHull(createGrid({ x_subdivisions: 4, y_subdivisions: 4, size: 2 }).positions)!;
    expect(flat.dimension).toBe(2);
    expect(flat.faces.length).toBe(2);
    expect(flat.faces[0].length).toBe(4);
    expect(convexHull([NaN, 0, 0, Infinity, 1, 1])).toBeNull();
  });
});

describe('mass properties', () => {
  it('matches the analytic box values for a hull cube, also when offset', () => {
    const offset = cubePts(0.5).map((v, i) => v + [3, -2, 1][i % 3]);
    const h = convexHull(offset)!;
    const mp = polyhedronMass(h.points, h.faces)!;
    expect(mp.volume).toBeCloseTo(1, 9);
    expect(mp.com[0]).toBeCloseTo(3, 9);
    expect(mp.com[1]).toBeCloseTo(-2, 9);
    expect(mp.com[2]).toBeCloseTo(1, 9);
    const box = boxMass([0.5, 0.5, 0.5]);
    for (let i = 0; i < 9; i++) expect(mp.inertia[i]).toBeCloseTo(box.inertia[i], 9);
  });

  it('approximates sphere, cylinder and cone hulls of fine meshes', () => {
    const sph = buildCollisionShape(
      'CONVEX_HULL',
      createIcoSphere({ subdivisions: 3, radius: 1 }),
      [1, 1, 1],
      {
        dynamic: true,
      },
    );
    if ('error' in sph) throw new Error();
    expect(sph.inertia[0]).toBeCloseTo(sphereMass(1).inertia[0], 1);
    const cyl = cylinderMass(1, 1);
    expect(cyl.inertia[8]).toBeCloseTo(0.5, 9);
    expect(cyl.inertia[0]).toBeCloseTo(0.25 + 1 / 3, 9);
    const cone = coneMass(1, 2);
    expect(cone.volume).toBeCloseTo((Math.PI * 2) / 3, 9);
    expect(cone.inertia[8]).toBeCloseTo(0.3, 9);
    // a capsule with zero cylinder length is a sphere
    const cap = capsuleMass(1, 0);
    expect(cap.inertia[0]).toBeCloseTo(0.4, 9);
    expect(cap.inertia[8]).toBeCloseTo(0.4, 9);
  });

  it('puts the centre of mass of CONE shapes a quarter height above the base', () => {
    const b = buildCollisionShape(
      'CONE',
      createCone({ vertices: 32, radius1: 1, radius2: 0, depth: 2 }),
      [1, 1, 1],
      {
        dynamic: true,
      },
    );
    if ('error' in b) throw new Error(b.error);
    expect(b.com[2]).toBeCloseTo(-0.5, 6);
    expect(b.shape.kind).toBe('cone');
  });
});

describe('collision shapes from meshes (Blender sizing rules)', () => {
  const cyl = createCylinder({ vertices: 32, radius: 0.5, depth: 3 });
  it('fits primitives to the bounding box with the object scale applied', () => {
    const b = buildCollisionShape('BOX', createCube({ size: 2 }), [2, 1, 0.5], { dynamic: true });
    if ('error' in b) throw new Error(b.error);
    expect(b.shape.kind).toBe('poly');
    const out = new Float64Array(3);
    supportCore(b.shape, 1, 1, 1, out);
    expect([...out]).toEqual([2, 1, 0.5]);
    const s = buildCollisionShape('SPHERE', cyl, [1, 1, 1], { dynamic: true });
    if ('error' in s) throw new Error(s.error);
    expect(s.shape).toMatchObject({ kind: 'sphere', radius: 1.5 });
    const c = buildCollisionShape('CAPSULE', cyl, [1, 1, 1], { dynamic: true });
    if ('error' in c) throw new Error(c.error);
    expect(c.shape).toMatchObject({ kind: 'capsule', radius: 0.5, halfHeight: 1 });
    const y = buildCollisionShape('CYLINDER', cyl, [2, 2, 1], { dynamic: true });
    if ('error' in y) throw new Error(y.error);
    expect(y.shape).toMatchObject({ kind: 'cylinder', radius: 1, halfHeight: 1.5 });
  });

  it('centres primitives on the bounding box of off-centre meshes', () => {
    const m = createCube({ size: 2 });
    m.positions = m.positions.map((v, i) => (i % 3 === 2 ? v + 1 : v)); // origin at the bottom
    const b = buildCollisionShape('BOX', m, [1, 1, 1], { dynamic: true });
    if ('error' in b) throw new Error(b.error);
    expect(b.com).toEqual([0, 0, 1]);
  });

  it('builds MESH shapes for static bodies and falls back to hulls for dynamic ones', () => {
    const s = buildCollisionShape('MESH', createPlane({ size: 4 }), [1, 1, 1], { dynamic: false });
    if ('error' in s) throw new Error(s.error);
    expect(s.shape.kind).toBe('mesh');
    const d = buildCollisionShape('MESH', createCube(), [1, 1, 1], { dynamic: true });
    if ('error' in d) throw new Error(d.error);
    expect(d.shape.kind).toBe('poly');
    expect(d.type).toBe('CONVEX_HULL');
    expect(d.notes.join()).toMatch(/MESH/);
  });

  it('marks internal flat edges of a tessellated plane inactive and boundary edges active', () => {
    const s = buildCollisionShape(
      'MESH',
      createGrid({ x_subdivisions: 3, y_subdivisions: 3, size: 3 }),
      [1, 1, 1],
      {
        dynamic: false,
      },
    );
    if ('error' in s || s.shape.kind !== 'mesh') throw new Error();
    const m = s.shape.mesh;
    let activeCount = 0;
    for (let t = 0; t < m.activeEdges.length; t++)
      for (let e = 0; e < 3; e++) if (m.activeEdges[t] & (1 << e)) activeCount++;
    expect(activeCount).toBe(4 * 3); // 3 boundary edges per side
  });

  it('marks convex creases of a closed mesh active', () => {
    const s = buildCollisionShape('MESH', createCube({ size: 2 }), [1, 1, 1], { dynamic: false });
    if ('error' in s || s.shape.kind !== 'mesh') throw new Error();
    let activeCount = 0;
    const m = s.shape.mesh;
    for (let t = 0; t < m.activeEdges.length; t++)
      for (let e = 0; e < 3; e++) if (m.activeEdges[t] & (1 << e)) activeCount++;
    expect(activeCount).toBe(24); // 12 cube edges seen from both adjacent triangles
  });

  it('rejects meshes without usable vertices', () => {
    expect(buildCollisionShape('BOX', createMesh(), [1, 1, 1], { dynamic: true })).toHaveProperty('error');
    expect(
      buildCollisionShape('BOX', createMesh({ positions: [NaN, 1, 2] }), [1, 1, 1], { dynamic: true }),
    ).toHaveProperty('error');
  });

  it('keeps flat meshes collidable with a minimal thickness', () => {
    const b = buildCollisionShape('BOX', createPlane({ size: 2 }), [1, 1, 1], { dynamic: true });
    if ('error' in b || b.shape.kind !== 'poly') throw new Error();
    expect(b.inertia.every(Number.isFinite)).toBe(true);
    const t = minHalfExtent(1);
    expect(b.shape.box!.half).toEqual([1, 1, t]);
    // the slab lies behind the plane (which faces +Z): its top is the plane itself
    expect(b.com).toEqual([0, 0, -t]);
    expect(b.notes.join(" ")).toMatch(/slab behind its faces/);
    expect(b.thickened).toEqual({ mesh: 0, collision: 2 * t });
    // a flat hull becomes a thin solid slab (a cuboid for a square plane)
    const h = buildCollisionShape('CONVEX_HULL', createPlane({ size: 2 }), [1, 1, 1], { dynamic: true });
    if ('error' in h || h.shape.kind !== 'poly') throw new Error();
    expect(h.shape.poly.flat).toBe(false);
    expect(Math.min(...h.shape.box!.half)).toBeCloseTo(t, 12);
    expect(Math.max(...h.shape.box!.half)).toBeCloseTo(1, 12);
    expect(h.com[2]).toBeCloseTo(-t, 12);
    expect(h.inertia.every(Number.isFinite)).toBe(true);
    const tri = buildCollisionShape(
      'CONVEX_HULL',
      createMesh({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1, 2]] }),
      [1, 1, 1],
      {
        dynamic: true,
      },
    );
    if ('error' in tri || tri.shape.kind !== 'poly') throw new Error();
    expect(tri.shape.poly.verts.length / 3).toBe(6);
    expect(tri.volume).toBeCloseTo(0.5 * 2 * minHalfExtent(0.5), 12);
  });
});

describe('GJK / EPA', () => {
  const sphereSup =
    (c: Vec3, r: number): SupportFn =>
    (dx, dy, dz, out) => {
      const l = Math.hypot(dx, dy, dz) || 1;
      out[0] = c[0] + (dx / l) * r;
      out[1] = c[1] + (dy / l) * r;
      out[2] = c[2] + (dz / l) * r;
    };
  const boxSup =
    (c: Vec3, h: Vec3): SupportFn =>
    (dx, dy, dz, out) => {
      out[0] = c[0] + (dx >= 0 ? h[0] : -h[0]);
      out[1] = c[1] + (dy >= 0 ? h[1] : -h[1]);
      out[2] = c[2] + (dz >= 0 ? h[2] : -h[2]);
    };

  it('measures distances and closest points of separated sets', () => {
    const g = gjk(boxSup([0, 0, 0], [1, 1, 1]), sphereSup([4, 0, 0], 1), [1, 0, 0]);
    expect(g.overlap).toBe(false);
    expect(g.distance).toBeCloseTo(2, 6);
    expect(g.pa[0]).toBeCloseTo(1, 6);
    expect(g.pb[0]).toBeCloseTo(3, 6);
    const e = gjk(boxSup([0, 0, 0], [1, 1, 1]), boxSup([3, 3, 0], [1, 1, 1]), [1, 1, 0]);
    expect(e.distance).toBeCloseTo(Math.SQRT2, 6);
  });

  it('finds penetration depth and normal of overlapping sets', () => {
    const a = boxSup([0, 0, 0], [1, 1, 1]);
    const b = boxSup([1.8, 0.2, 0.1], [1, 1, 1]);
    const g = gjk(a, b, [1, 0, 0]);
    expect(g.overlap).toBe(true);
    const e = epa(a, b, g.simplex)!;
    expect(e.depth).toBeCloseTo(0.2, 6);
    expect(e.normal[0]).toBeCloseTo(1, 6);
    const s = epa(
      sphereSup([0, 0, 0], 1),
      sphereSup([0, 0, 1.5], 1),
      gjk(sphereSup([0, 0, 0], 1), sphereSup([0, 0, 1.5], 1), [0, 0, 1]).simplex,
    )!;
    expect(s.depth).toBeCloseTo(0.5, 2);
    expect(s.normal[2]).toBeCloseTo(1, 2);
  });

  it('does not take a flat simplex near a face for an overlap (no dropped contacts)', () => {
    // a sphere whose centre is 3.6 mm from a box face: GJK collects four coplanar points of that
    // face, whose side tests are rounding noise; the generic path must match the closed form
    const box = buildCollisionShape('BOX', createCube({ size: 1 }), [1.5, 1, 1], { dynamic: true });
    if ('error' in box || box.shape.kind !== 'poly') throw new Error('box expected');
    const hull: Shape = { kind: 'poly', poly: box.shape.poly };
    const sphere = shapeOf('SPHERE', createUVSphere({ radius: 0.5 }));
    const at = (shape: Shape, p: Vec3, q: [number, number, number, number]): CollisionPose => ({
      shape,
      px: p[0],
      py: p[1],
      pz: p[2],
      R: quatToMat3(q),
      boundingRadius: boundingRadius(shape),
    });
    const P: Vec3 = [0.2621709108352661, 0.9022690057754517, -0.03577888011932373];
    const QA: [number, number, number, number] = [
      0.5497542965238732, 0.5877717613386175, -0.0019024880067923641, 0.5935410268598326,
    ];
    const QB: [number, number, number, number] = [
      -0.3572062461578949, 0.7924403118064235, -0.45751967805498306, 0.18739742293422298,
    ];
    const closed: ContactCandidate[] = [];
    const generic: ContactCandidate[] = [];
    collide(at(sphere, P, QB), at(box.shape, [0, 0, 0], QA), 0.1, closed);
    collide(at(sphere, P, QB), at(hull, [0, 0, 0], QA), 0.1, generic);
    expect(closed.length).toBe(1);
    expect(generic.length).toBe(1);
    expect(generic[0].s).toBeCloseTo(closed[0].s, 9);
    for (let k = 0; k < 3; k++) expect(generic[0].n[k]).toBeCloseTo(closed[0].n[k], 9);
  });

  it('expands EPA from a flat seed simplex instead of giving up', () => {
    const a = boxSup([0, 0, 0], [1, 1, 1]);
    const b = boxSup([1.8, 0.2, 0.1], [1, 1, 1]);
    // four corners of the face x = 0.2 of A − B (coplanar)
    const seed = [
      [1, -1, -1],
      [1, 1, -1],
      [1, 1, 1],
      [1, -1, 1],
    ].map(([x, y, z]) => {
      const pa = new Float64Array(3);
      const pb = new Float64Array(3);
      a(x, y, z, pa);
      b(-x, -y, -z, pb);
      return {
        a: [...pa] as Vec3,
        b: [...pb] as Vec3,
        w: [pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]] as Vec3,
      };
    });
    expect(seed.every((v) => Math.abs(v.w[0] - 0.2) < 1e-12)).toBe(true);
    const e = epa(a, b, seed)!;
    expect(e).not.toBeNull();
    expect(e.depth).toBeCloseTo(0.2, 6);
    expect(e.normal[0]).toBeCloseTo(1, 6);
  });
});

describe('SAT between polyhedra', () => {
  it('gives a 4-point face manifold for a box resting on a box', () => {
    const A = boxPolyhedron([2, 2, 0.5]);
    const B = transformPolyhedron(boxPolyhedron([0.5, 0.5, 0.5]), I3, [0.3, -0.2, 0.99]);
    const out: ContactCandidate[] = [];
    expect(collidePolyhedra(A, B, 0.05, out)).toBe(true);
    expect(out.length).toBe(4);
    for (const c of out) {
      expect(c.n[2]).toBeCloseTo(1, 9);
      expect(c.s).toBeCloseTo(-0.01, 9);
    }
  });

  it('reports separation beyond the speculative distance and edge contacts', () => {
    const A = boxPolyhedron([1, 1, 1]);
    expect(collidePolyhedra(A, transformPolyhedron(A, I3, [0, 0, 2.2]), 0.1, [])).toBe(false);
    // two boxes rotated 45° about orthogonal axes touch edge to edge
    const ra = quatToMat3(quatFromEuler([0, Math.PI / 4, 0]));
    const rb = quatToMat3(quatFromEuler([Math.PI / 4, 0, 0]));
    const P = transformPolyhedron(A, ra, [0, 0, 0]);
    const Q = transformPolyhedron(A, rb, [0, 0, 2 * Math.SQRT2 - 0.01]);
    const out: ContactCandidate[] = [];
    expect(collidePolyhedra(P, Q, 0.05, out)).toBe(true);
    expect(out.length).toBe(1);
    expect(out[0].n[2]).toBeCloseTo(1, 6);
    expect(out[0].s).toBeCloseTo(-0.01, 6);
    expect(out[0].pa[2]).toBeCloseTo(Math.SQRT2, 6);
  });
});

describe('narrow phase', () => {
  const box = shapeOf('BOX');
  const sphere = shapeOf('SPHERE');
  const capsule = shapeOf('CAPSULE', createCylinder({ vertices: 16, radius: 0.5, depth: 3 }));
  const cylinder = shapeOf('CYLINDER', createCylinder({ vertices: 16, radius: 1, depth: 2 }));
  const cone = shapeOf('CONE', createCone({ vertices: 16, radius1: 1, radius2: 0, depth: 2 }));
  const hull = shapeOf('CONVEX_HULL', createIcoSphere({ subdivisions: 1, radius: 1 }));
  const ground = shapeOf('BOX', createCube({ size: 2 }));
  const groundPose = (z = -1) => pose(ground, [0, 0, z]);

  it('handles sphere pairs and sphere against boxes', () => {
    const out: ContactCandidate[] = [];
    collide(pose(sphere, [0, 0, 0]), pose(sphere, [1.9, 0, 0]), 0.05, out);
    expect(out.length).toBe(1);
    expect(out[0].s).toBeCloseTo(-0.1, 9);
    expect(out[0].n[0]).toBeCloseTo(1, 9);
    out.length = 0;
    collide(groundPose(), pose(sphere, [0.2, 0.1, 0.98]), 0.05, out);
    expect(out.length).toBe(1);
    expect(out[0].n[2]).toBeCloseTo(1, 6);
    expect(out[0].s).toBeCloseTo(-0.02, 6);
  });

  it('gives two contacts for a capsule lying on a box and four for a standing cylinder', () => {
    const out: ContactCandidate[] = [];
    collide(groundPose(), pose(capsule, [0, 0, 0.49], [Math.PI / 2, 0, 0]), 0.05, out);
    expect(out.length).toBe(2);
    for (const c of out) expect(c.s).toBeCloseTo(-0.01, 6);
    out.length = 0;
    collide(groundPose(-1), pose(cylinder, [0, 0, 0.995]), 0.05, out);
    expect(out.length).toBe(4);
    for (const c of out) {
      expect(c.s).toBeCloseTo(-0.005, 4);
      expect(c.n[2]).toBeCloseTo(1, 4);
    }
    out.length = 0;
    // lying on its side: a line contact
    collide(groundPose(-1), pose(cylinder, [0, 0, 0.99], [Math.PI / 2, 0, 0]), 0.05, out);
    expect(out.length).toBe(2);
    out.length = 0;
    // cone standing on its base (centre of mass is a quarter height above it)
    collide(groundPose(-1), pose(cone, [0, 0, 0.49]), 0.05, out);
    expect(out.length).toBe(4);
    for (const c of out) expect(c.s).toBeCloseTo(-0.01, 4);
  });

  it('handles hull pairs and hulls on boxes', () => {
    const out: ContactCandidate[] = [];
    // the icosahedron's lowest vertices are at z = -0.8507
    collide(groundPose(), pose(hull, [0, 0, 0.84]), 0.05, out);
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      expect(c.n[2]).toBeCloseTo(1, 6);
      expect(c.s).toBeCloseTo(-0.0107, 3);
    }
    out.length = 0;
    collide(pose(hull, [0, 0, 0]), pose(hull, [0, 0, 1.69]), 0.05, out);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].n[2]).toBeGreaterThan(0.9);
  });

  it('collides convex shapes with triangle meshes without ghost normals at internal edges', () => {
    const grid = buildCollisionShape(
      'MESH',
      createGrid({ x_subdivisions: 4, y_subdivisions: 4, size: 8 }),
      [1, 1, 1],
      {
        dynamic: false,
      },
    );
    if ('error' in grid) throw new Error(grid.error);
    const floor = pose(grid.shape);
    // a box centred over internal edges and vertices of the tessellated floor
    for (const x of [0, 0.01, 1.995, 2]) {
      const out: ContactCandidate[] = [];
      collide(pose(box, [x, 0.003, 0.99]), floor, 0.05, out);
      expect(out.length).toBeGreaterThanOrEqual(3);
      for (const c of out) {
        expect(c.n[2]).toBeCloseTo(-1, 6); // from the box down to the floor
        expect(c.s).toBeCloseTo(-0.01, 6);
      }
    }
    const out: ContactCandidate[] = [];
    collide(floor, pose(sphere, [0.5, 0.25, 0.97]), 0.05, out);
    expect(out.length).toBe(1);
    expect(out[0].n[2]).toBeCloseTo(1, 6);
    expect(out[0].s).toBeCloseTo(-0.03, 6);
  });
});

describe('closed-form box and sphere tests', () => {
  const I: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const rotZ = (a: number): Mat3 => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];

  it('gives face manifolds for stacked boxes and rejects separated ones', () => {
    const out: ContactCandidate[] = [];
    // B (rotated 30° about Z) rests on A, penetrating 0.01
    expect(collideBoxes([1, 1, 0.5], [0.5, 0.5, 0.5], rotZ(Math.PI / 6), [0.1, 0, 0.99], 0.05, out)).toBe(
      true,
    );
    expect(out.length).toBe(4);
    for (const c of out) {
      expect(c.n).toEqual([0, 0, 1]);
      expect(c.s).toBeCloseTo(-0.01, 12);
      expect(c.pa[2]).toBeCloseTo(0.5, 12);
    }
    out.length = 0;
    expect(collideBoxes([1, 1, 0.5], [0.5, 0.5, 0.5], I, [0, 0, 1.06], 0.05, out)).toBe(false);
    expect(collideBoxes([1, 1, 0.5], [0.5, 0.5, 0.5], I, [0, 0, 1.04], 0.05, out)).toBe(true);
    expect(out.every((c) => Math.abs(c.s - 0.04) < 1e-12)).toBe(true);
  });

  it('gives one edge-edge contact for crossed edges', () => {
    // two unit cubes turned 45° about crossing horizontal axes touch edge on edge
    const c = Math.SQRT1_2;
    const rx: Mat3 = [1, 0, 0, 0, c, -c, 0, c, c];
    const out: ContactCandidate[] = [];
    // A rotated so an edge points up: express B relative to A (A edge along Y at x=0,z=√2/2·2)
    const rA: Mat3 = [c, 0, -c, 0, 1, 0, c, 0, c]; // A's frame rotated -45° about Y (edge up along Y)
    const rB = mulMat3(transpose3(rA), rx); // B rotated 45° about X (edge down along X)
    const d = Math.SQRT2 * 0.5 * 2 - 0.01; // centres closer than the two half diagonals
    const tB = mulMat3TVec(rA, [0, 0, d]);
    expect(collideBoxes([0.5, 0.5, 0.5], [0.5, 0.5, 0.5], rB, tB, 0.05, out)).toBe(true);
    expect(out.length).toBe(1);
    expect(out[0].s).toBeCloseTo(-0.01, 9);
    const nWorld = mulMat3Vec(rA, out[0].n);
    expect(nWorld[2]).toBeCloseTo(1, 9);
  });

  it('matches the general SAT on random box pairs', () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const boxA = shapeOf('BOX', createCube({ size: 2 }));
    for (let k = 0; k < 40; k++) {
      const hb: Vec3 = [0.3 + Math.abs(rnd()), 0.3 + Math.abs(rnd()), 0.3 + Math.abs(rnd())];
      const q = quatFromEuler([rnd() * 3, rnd() * 3, rnd() * 3]);
      const r = quatToMat3(q);
      const t: Vec3 = [rnd() * 1.5, rnd() * 1.5, 1 + Math.abs(rnd()) * 1.2];
      const special: ContactCandidate[] = [];
      const hit = collideBoxes([1, 1, 1], hb, r, t, 0.05, special);
      const general: ContactCandidate[] = [];
      const pb = transformPolyhedron(boxPolyhedron(hb), r, t);
      const hit2 = collidePolyhedra((boxA as { kind: 'poly'; poly: Polyhedron }).poly, pb, 0.05, general);
      expect(hit).toBe(hit2);
      if (!hit) continue;
      const deepest = (cs: ContactCandidate[]) => Math.min(...cs.map((c) => c.s));
      expect(deepest(special)).toBeCloseTo(deepest(general), 6);
      expect(
        special[0].n[0] * general[0].n[0] +
          special[0].n[1] * general[0].n[1] +
          special[0].n[2] * general[0].n[2],
      ).toBeGreaterThan(0.999);
    }
  });

  it('collides spheres with boxes inside and outside', () => {
    const out: ContactCandidate[] = [];
    expect(collideSphereBox([0, 0, 1.3], 0.5, [1, 1, 1], 0.05, out)).toBe(true);
    expect(out[0]).toMatchObject({ n: [0, 0, 1] });
    expect(out[0].s).toBeCloseTo(-0.2, 12);
    out.length = 0;
    // corner region: normal along the diagonal
    collideSphereBox([1.2, 1.2, 1.2], 0.5, [1, 1, 1], 0.05, out);
    expect(out[0].s).toBeCloseTo(Math.sqrt(3) * 0.2 - 0.5, 12);
    expect(out[0].n[0]).toBeCloseTo(1 / Math.sqrt(3), 12);
    out.length = 0;
    // centre inside: pushed out through the nearest face
    collideSphereBox([0.9, 0, 0.2], 0.5, [1, 1, 1], 0.05, out);
    expect(out[0].n).toEqual([1, 0, 0]);
    expect(out[0].s).toBeCloseTo(-0.6, 12);
    expect(collideSphereBox([0, 0, 2], 0.5, [1, 1, 1], 0.05, out)).toBe(false);
  });

  it('finds closest points on triangles in every Voronoi region', () => {
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [2, 0, 0];
    const c: Vec3 = [0, 2, 0];
    expect(closestPointOnTriangle([0.5, 0.5, 3], a, b, c)).toEqual([0.5, 0.5, 0]);
    expect(closestPointOnTriangle([-1, -1, 0], a, b, c)).toEqual([0, 0, 0]);
    expect(closestPointOnTriangle([3, -1, 1], a, b, c)).toEqual([2, 0, 0]);
    expect(closestPointOnTriangle([1, -2, 0], a, b, c)).toEqual([1, 0, 0]);
    const q = closestPointOnTriangle([2, 2, 0], a, b, c);
    expect(q[0]).toBeCloseTo(1, 12);
    expect(q[1]).toBeCloseTo(1, 12);
  });

  it('keeps every vertex of a convex hull and finds its support points exactly', () => {
    // Blender (Bullet) collides with the full hull of the mesh vertices; a hull simplified to
    // fewer vertices lies inside the mesh (round objects sank into the ground)
    const uv = createUVSphere({ radius: 1, segments: 32, ring_count: 16 });
    const scale: Vec3 = [1.3, 0.7, 1];
    const b = buildCollisionShape('CONVEX_HULL', uv, scale, { dynamic: true });
    if ('error' in b || b.shape.kind !== 'poly') throw new Error('hull expected');
    const P = b.shape.poly;
    expect(P.verts.length / 3).toBe(482);
    expect(P.graph).toBeDefined(); // large hull: hill-climbing support queries
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const out = new Float64Array(3);
    for (let k = 0; k < 500; k++) {
      const d: Vec3 = [rnd(), rnd(), rnd()];
      // the furthest mesh vertex (object space, scaled, relative to the centre of mass)
      let best = -Infinity;
      for (let i = 0; i < uv.positions.length; i += 3) {
        let dot = 0;
        for (let a = 0; a < 3; a++) dot += (uv.positions[i + a] * scale[a] - b.com[a]) * d[a];
        best = Math.max(best, dot);
      }
      supportCore(b.shape, d[0], d[1], d[2], out);
      expect(out[0] * d[0] + out[1] * d[1] + out[2] * d[2]).toBeCloseTo(best, 12);
      const i = polySupport(P, d[0], d[1], d[2]);
      expect([...P.verts.subarray(i * 3, i * 3 + 3)]).toEqual([...out]);
    }
    // hulls with many faces pick the supporting face by climbing: still the best aligned one
    const ico = buildCollisionShape('CONVEX_HULL', createIcoSphere({ subdivisions: 5 }), [1, 1, 1], {
      dynamic: true,
    });
    if ('error' in ico || ico.shape.kind !== 'poly') throw new Error('hull expected');
    const Q = ico.shape.poly;
    expect(Q.faces.length).toBe(5120);
    for (let k = 0; k < 200; k++) {
      const d: Vec3 = [rnd(), rnd(), rnd()];
      const l = Math.hypot(...d);
      let best = -Infinity;
      for (let f = 0; f < Q.faces.length; f++)
        best = Math.max(
          best,
          (Q.planes[f * 4] * d[0] + Q.planes[f * 4 + 1] * d[1] + Q.planes[f * 4 + 2] * d[2]) / l,
        );
      const face = supportingFace(ico.shape, d[0], d[1], d[2]);
      const f = Q.faces.findIndex(
        (fv) =>
          fv.length * 3 === face.length &&
          fv.every((v, j) => [0, 1, 2].every((a) => Q.verts[v * 3 + a] === face[j * 3 + a])),
      );
      expect(f).toBeGreaterThanOrEqual(0);
      const got = (Q.planes[f * 4] * d[0] + Q.planes[f * 4 + 1] * d[1] + Q.planes[f * 4 + 2] * d[2]) / l;
      expect(got).toBeCloseTo(best, 12);
    }
  });

  it('detects cuboid hulls, also rotated in object space', () => {
    const cube = buildCollisionShape('CONVEX_HULL', createCube({ size: 2 }), [1, 2, 3], { dynamic: true });
    if ('error' in cube || cube.shape.kind !== 'poly') throw new Error();
    expect([...cube.shape.box!.half].sort()).toEqual([1, 2, 3]);
    expect(cube.shape.box!.aligned).toBe(true);
    const turned = createCube({ size: 2 });
    for (let i = 0; i < turned.positions.length; i += 3) {
      const [x, y] = [turned.positions[i], turned.positions[i + 1]];
      turned.positions[i] = x * Math.cos(0.3) - y * Math.sin(0.3);
      turned.positions[i + 1] = x * Math.sin(0.3) + y * Math.cos(0.3);
    }
    const t = buildCollisionShape('CONVEX_HULL', turned, [1, 1, 1], { dynamic: true });
    if ('error' in t || t.shape.kind !== 'poly') throw new Error();
    expect(t.shape.box!.aligned).toBe(false);
    expect(t.shape.box!.half.map((h) => +h.toFixed(9))).toEqual([1, 1, 1]);
    // a box on the ground through the oriented path agrees with the aligned one
    const ground = pose(shapeOf('BOX', createCube({ size: 2 })), [0, 0, -1]);
    const out: ContactCandidate[] = [];
    collide(ground, pose(t.shape, [0, 0, 0.99], [0, 0, -0.3]), 0.05, out);
    expect(out.length).toBe(4);
    for (const c of out) expect(c.s).toBeCloseTo(-0.01, 9);
    expect(cuboidFrame(boxPolyhedron([1, 1, 1]))!.aligned).toBe(true);
    const ico = shapeOf('CONVEX_HULL', createIcoSphere({ subdivisions: 1 }));
    expect((ico as { box?: unknown }).box).toBeUndefined();
  });

  it('never reports contacts between features far apart on large triangles (internal edges)', () => {
    const plane = buildCollisionShape('MESH', createPlane({ size: 40 }), [1, 1, 1], { dynamic: false });
    const domino = buildCollisionShape('BOX', createCube({ size: 1 }), [0.1, 0.5, 1], { dynamic: true });
    if ('error' in plane || 'error' in domino) throw new Error();
    for (const [p, e] of [
      [
        [1.5, 0.1, 0.12],
        [0.3, 1.4, 0.3],
      ],
      [
        [1, 0.05, 0.05],
        [0.02, 1.5708, 0.01],
      ],
      [
        [-3, 2.9, 0.2],
        [1.2, 0.4, -0.7],
      ],
    ] as [Vec3, Vec3][]) {
      const out: ContactCandidate[] = [];
      collide(pose(plane.shape), pose(domino.shape, p, e), 0.04, out);
      expect(out.length).toBeGreaterThan(0);
      for (const c of out) {
        expect(c.n[2]).toBeCloseTo(1, 6);
        // the two witness points are the contact's own features: |pb − pa| = |separation|
        expect(Math.hypot(c.pb[0] - c.pa[0], c.pb[1] - c.pa[1], c.pb[2] - c.pa[2])).toBeCloseTo(
          Math.abs(c.s),
          6,
        );
      }
    }
  });
});

describe('manifold helpers and math', () => {
  it('reduces large manifolds to the 4 most useful points', () => {
    const c: ContactCandidate[] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      c.push({
        pa: [Math.cos(a), Math.sin(a), 0],
        pb: [Math.cos(a), Math.sin(a), -0.01],
        n: [0, 0, 1],
        s: i === 3 ? -0.02 : -0.01,
      });
    }
    const r = reduceManifold(c);
    expect(r.length).toBe(4);
    expect(r[0].s).toBe(-0.02);
  });

  it('clips a polygon against a reference face', () => {
    const out: ContactCandidate[] = [];
    clipFeatures(
      [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
      [0.5, 0.5, -0.01, 1.5, 0.5, -0.01, 1.5, 1.5, -0.01, 0.5, 1.5, -0.01],
      [0, 0, 1],
      0.05,
      out,
    );
    expect(out.length).toBe(4);
    for (const c of out) {
      expect(Math.max(Math.abs(c.pa[0]), Math.abs(c.pa[1]))).toBeLessThanOrEqual(1 + 1e-12);
      expect(c.s).toBeCloseTo(-0.01, 12);
    }
  });

  it('simplifies large faces before clipping (caps of high-poly hulls)', () => {
    const disc = (n: number, r: number, z: number, ccw: boolean): number[] => {
      const out: number[] = [];
      for (let k = 0; k < n; k++) {
        const a = (2 * Math.PI * (ccw ? k : n - 1 - k)) / n;
        out.push(r * Math.cos(a), r * Math.sin(a), z);
      }
      return out;
    };
    const big = disc(256, 1, 0, true);
    const deep: Vec3 = [Math.cos(0.3), Math.sin(0.3), 0];
    const small = simplifyPolygon(big, 256, 0, 0, 1, deep);
    expect(small.length / 3).toBeGreaterThanOrEqual(MAX_CLIP_VERTICES);
    expect(small.length / 3).toBeLessThanOrEqual(MAX_CLIP_VERTICES + 1);
    // a subsequence of the polygon's vertices (same winding) that keeps the deepest one
    let last = -1;
    for (let i = 0; i < small.length; i += 3) {
      const k = big.findIndex((_, j) => j % 3 === 0 && big[j] === small[i] && big[j + 1] === small[i + 1]);
      expect(k).toBeGreaterThan(last);
      last = k;
    }
    const kDeep = Math.round((0.3 / (2 * Math.PI)) * 256) * 3;
    expect(
      small.some((_, i) => i % 3 === 0 && small[i] === big[kDeep] && small[i + 1] === big[kDeep + 1]),
    ).toBe(true);
    // a 256-gon cap resting on another: a full-size manifold, reduced to four points
    const out: ContactCandidate[] = [];
    expect(clipFeatures(big, disc(256, 1, -0.01, false), [0, 0, 1], 0.05, out)).toBeGreaterThan(4);
    const four = reduceManifold(out);
    expect(four.length).toBe(4);
    for (const c of four) {
      expect(Math.hypot(c.pa[0], c.pa[1])).toBeGreaterThan(0.97);
      expect(c.s).toBeCloseTo(-0.01, 12);
    }
  });

  it('round-trips rotations and decomposes scaled matrices', () => {
    const q = quatFromEuler([0.3, -1.2, 2.5]);
    const back = mat3ToQuat(quatToMat3(q));
    const s = Math.sign(back[3] * q[3] || 1);
    back.forEach((v, i) => expect(v * s).toBeCloseTo(q[i], 12));
    const m = compose4([1, 2, 3], [0.3, -1.2, 2.5], [2, 0.5, -1]);
    const d = decomposeRigid(m);
    expect(d.position).toEqual([1, 2, 3]);
    expect(Math.abs(d.scale[0])).toBeCloseTo(2, 12);
    expect(d.scale[0] * d.scale[1] * d.scale[2]).toBeCloseTo(-1, 12);
    const mid = slerpQ([0, 0, 0, 1], [0, 0, 1, 0], 0.5);
    expect(mid[2]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(supportingFace(shapeOf('BOX'), 0, 0, 1).length).toBe(12);
  });

  it('queries triangles of a BVH in ascending order', () => {
    const g = createGrid({ x_subdivisions: 10, y_subdivisions: 10, size: 10 });
    const tris: number[] = [];
    for (const f of g.faces) tris.push(f[0], f[1], f[2], f[0], f[2], f[3]);
    const bvh = new TriangleBVH(Float64Array.from(g.positions), Int32Array.from(tris));
    const found = bvh.query(-0.5, -0.5, -1, 0.5, 0.5, 1, []);
    expect(found.length).toBeGreaterThanOrEqual(8);
    expect([...found].sort((a, b) => a - b)).toEqual(found);
    // brute force agrees
    const brute: number[] = [];
    for (let t = 0; t < tris.length / 3; t++) {
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = tris[t * 3 + k] * 3;
        x0 = Math.min(x0, g.positions[v]);
        x1 = Math.max(x1, g.positions[v]);
        y0 = Math.min(y0, g.positions[v + 1]);
        y1 = Math.max(y1, g.positions[v + 1]);
      }
      if (!(x0 > 0.5 || x1 < -0.5 || y0 > 0.5 || y1 < -0.5)) brute.push(t);
    }
    expect(found).toEqual(brute);
  });
});
