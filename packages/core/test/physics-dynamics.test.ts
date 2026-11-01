import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import type { RigidBodyData } from '../src/doc/types';
import type { Mat4 } from '../src/math/types';
import { createCube, createGrid, createIcoSphere, createPlane, createUVSphere } from '../src/mesh/primitives';
import { createMesh } from '../src/mesh/types';
import { RigidBodySimulator, rigidBodyCacheInfo } from '../src/physics/rigid-body';
import {
  G,
  directSimulation,
  euler,
  hostOf,
  loc,
  physicsScene,
  range,
  rb,
  rotationAngle,
  simulate,
  upZ,
} from './physics-helpers';

const FPS = 24;
const noDamping: Partial<RigidBodyData> = { linear_damping: 0, angular_damping: 0 };

describe('free fall and integration', () => {
  it('follows the semi-implicit Euler solution of ½gt² exactly without damping', () => {
    const s = physicsScene();
    const ball = s.add('Ball', s.sphere(0.5), rb('ACTIVE', { collision_shape: 'SPHERE', ...noDamping }), {
      location: [0, 0, 50],
    });
    const frames = range(2, 49);
    const res = simulate(s.doc, frames);
    const dt = 1 / FPS / 10;
    for (const f of frames) {
      const n = (f - 1) * 10;
      const z = loc(res.get(f)!.get(ball)!)[2];
      expect(z).toBeCloseTo(50 - (G * dt * dt * n * (n + 1)) / 2, 9);
      // and within the O(dt) integration error of the analytic ½gt²
      const t = (f - 1) / FPS;
      expect(Math.abs(z - (50 - 0.5 * G * t * t))).toBeLessThan(0.5 * G * t * dt + 1e-9);
    }
  });

  it('applies Blender damping, time_scale, use_gravity and a custom gravity vector', () => {
    const fall = (
      setup: (s: ReturnType<typeof physicsScene>) => void,
      damping: Partial<RigidBodyData> = noDamping,
    ) => {
      const s = physicsScene();
      const ball = s.add('Ball', s.sphere(0.5), rb('ACTIVE', { collision_shape: 'SPHERE', ...damping }), {
        location: [0, 0, 100],
      });
      setup(s);
      return loc(simulate(s.doc, [25]).get(25)!.get(ball)!);
    };
    const free = fall(() => {});
    expect(free[2]).toBeCloseTo(100 - 0.5 * G - (0.5 * G) / 240, 6);
    // linear damping: v *= (1 - d)^dt, so the body falls less far
    const damped = fall(() => {}, { linear_damping: 0.5, angular_damping: 0 });
    expect(100 - damped[2]).toBeLessThan(0.85 * (100 - free[2]));
    expect(100 - damped[2]).toBeGreaterThan(0.6 * (100 - free[2]));
    // half the time scale: frame 25 is 0.5 s of simulated time
    const slow = fall((s) => s.setWorld({ time_scale: 0.5 }));
    const dt = 0.5 / FPS / 10;
    expect(slow[2]).toBeCloseTo(100 - (G * dt * dt * 240 * 241) / 2, 6);
    expect(fall((s) => s.setWorld({ time_scale: 0 }))).toEqual([0, 0, 100]);
    expect(fall((s) => s.doc.updateScene({ use_gravity: false }))).toEqual([0, 0, 100]);
    const sideways = fall((s) => s.doc.updateScene({ gravity: [4, 0, 0] }));
    expect(sideways[2]).toBeCloseTo(100, 9);
    expect(sideways[0]).toBeCloseTo(0.5 * 4 * (1 + 1 / 240), 6);
  });
});

describe('contacts', () => {
  it('bounces to e² of the drop height (restitution multiplies like Bullet)', () => {
    for (const e of [0.5, 0.8]) {
      const s = physicsScene();
      s.ground({ restitution: 1 });
      const ball = s.add(
        'Ball',
        s.sphere(0.5),
        rb('ACTIVE', { collision_shape: 'SPHERE', restitution: e, ...noDamping }),
        {
          location: [0, 0, 2.5],
        },
      );
      const res = simulate(s.doc, range(2, 70));
      const z = range(2, 70).map((f) => loc(res.get(f)!.get(ball)!)[2]);
      const low = z.indexOf(Math.min(...z.slice(0, 30)));
      expect(z[low]).toBeGreaterThan(0.45); // never sinks through the ground
      const apex = Math.max(...z.slice(low));
      expect(apex - 0.5).toBeGreaterThan(e * e * 2 * 0.95);
      expect(apex - 0.5).toBeLessThan(e * e * 2 * 1.05);
    }
    // a ground without restitution kills the bounce
    const s = physicsScene();
    s.ground();
    const ball = s.add('Ball', s.sphere(0.5), rb('ACTIVE', { collision_shape: 'SPHERE', restitution: 1 }), {
      location: [0, 0, 2.5],
    });
    const res = simulate(s.doc, range(2, 40));
    expect(Math.max(...range(20, 40).map((f) => loc(res.get(f)!.get(ball)!)[2]))).toBeLessThan(0.52);
  });

  it('keeps a box resting on a plane still for 250 frames, with and without sleeping', () => {
    const s = physicsScene();
    s.ground();
    const box = s.add('Box', s.cube(1), rb('ACTIVE', { collision_shape: 'BOX' }), {
      location: [0.3, -0.2, 0.5],
      rotation_euler: [0, 0, 0.4],
    });
    const res = simulate(s.doc, range(2, 250));
    for (const f of range(2, 250)) {
      const m = res.get(f)!.get(box)!;
      const p = loc(m);
      expect(Math.abs(p[0] - 0.3)).toBeLessThan(1e-3);
      expect(Math.abs(p[1] + 0.2)).toBeLessThan(1e-3);
      expect(p[2]).toBeGreaterThan(0.5 - 0.004);
      expect(p[2]).toBeLessThan(0.5 + 1e-4);
      expect(euler(m)[2]).toBeCloseTo(0.4, 3);
      expect(upZ(m)).toBeGreaterThan(1 - 1e-6);
    }
    expect(rigidBodyCacheInfo(s.doc)!.objects.find((o) => o.object === box)!.sleeping).toBe(true);
    // the solver alone (no sleeping) holds it too, without jitter
    const sim = directSimulation(s.doc, { sleeping: false });
    const body = sim.outputs[0];
    let maxDrift = 0;
    for (let f = 2; f <= 250; f++) {
      sim.advance(null);
      maxDrift = Math.max(maxDrift, Math.hypot(body.px - 0.3, body.py + 0.2), Math.abs(body.pz - 0.5));
    }
    expect(maxDrift).toBeLessThan(4e-3);
    expect(Math.hypot(body.vx, body.vy, body.vz)).toBeLessThan(0.02);
  });

  it('keeps a stack of 5 boxes standing', () => {
    for (const sleeping of [true, false]) {
      const s = physicsScene();
      s.ground();
      const ids = range(0, 4).map((i) =>
        s.add(`Box${i}`, s.cube(1), rb('ACTIVE'), { location: [0, 0, 0.5 + i] }),
      );
      const sim = directSimulation(s.doc, { sleeping });
      for (let f = 2; f <= 250; f++) sim.advance(null);
      const m = sim.matrices(250);
      ids.forEach((id, i) => {
        const p = loc(m.get(id)!);
        expect(Math.hypot(p[0], p[1])).toBeLessThan(0.01);
        expect(Math.abs(p[2] - (0.5 + i))).toBeLessThan(0.01);
        expect(upZ(m.get(id)!)).toBeGreaterThan(0.9999);
      });
    }
  });

  it('topples a line of dominoes in order', () => {
    const s = physicsScene();
    s.ground({}, 40);
    const n = 8;
    const ids = range(0, n - 1).map((i) =>
      s.add(`Domino${i}`, s.cube(1), rb('ACTIVE', { collision_shape: 'BOX' }), {
        location: [i * 0.5, 0, 0.5],
        scale: [0.1, 0.5, 1],
        rotation_euler: [0, i === 0 ? 0.3 : 0, 0],
      }),
    );
    const frames = range(2, 150);
    const res = simulate(s.doc, frames);
    const toppled = ids.map(
      (id) => frames.find((f) => upZ(res.get(f)!.get(id)!) < Math.cos(0.35)) ?? Infinity,
    );
    for (let i = 1; i < n; i++) expect(toppled[i]).toBeGreaterThan(toppled[i - 1]);
    expect(toppled[n - 1]).toBeLessThan(80);
    for (const id of ids) {
      const m = res.get(150)!.get(id)!;
      expect(upZ(m)).toBeLessThan(Math.cos(1));
      expect(Math.abs(loc(m)[1])).toBeLessThan(0.05); // they fall straight, not sideways
    }
  });

  it('rolls a sphere down a slope at 5/7 g sin θ without slipping', () => {
    const s = physicsScene();
    const theta = 0.35;
    s.add('Slope', s.cube(1), rb('PASSIVE', { collision_shape: 'BOX' }), {
      scale: [20, 4, 1],
      rotation_euler: [0, theta, 0],
    });
    const ball = s.add('Ball', s.sphere(0.5), rb('ACTIVE', { collision_shape: 'SPHERE', ...noDamping }), {
      location: [Math.sin(theta), 0, Math.cos(theta)],
    });
    const res = simulate(s.doc, [13, 25, 37]);
    const start = [Math.sin(theta), 0, Math.cos(theta)];
    for (const f of [13, 25, 37]) {
      const m = res.get(f)!.get(ball)!;
      const p = loc(m);
      const t = (f - 1) / FPS;
      const d = Math.hypot(p[0] - start[0], p[1] - start[1], p[2] - start[2]);
      const expected = 0.5 * (5 / 7) * G * Math.sin(theta) * t * t;
      expect(d / expected).toBeGreaterThan(0.97);
      expect(d / expected).toBeLessThan(1.03);
      // stays on the surface and rolls: rotation angle = distance / radius
      expect(p[0] * Math.sin(theta) + p[2] * Math.cos(theta)).toBeCloseTo(1, 2);
      const identity: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      if (d / 0.5 < Math.PI - 0.2) expect(rotationAngle(identity, m)).toBeCloseTo(d / 0.5, 1);
    }
  });

  it('collides round meshes with their full convex hull: they rest on and roll over their surface', () => {
    // Blender (Bullet) keeps every hull vertex. A hull simplified to fewer vertices lies inside
    // the mesh: this ball sank 4.6 cm into the ground and stuck on a facet of the ramp below.
    const uv = createUVSphere({ radius: 1, segments: 32, ring_count: 16 });
    const s = physicsScene();
    s.ground({}, 40);
    const ball = s.add(
      'Ball',
      s.mesh('uv', () => uv),
      rb('ACTIVE'),
      { location: [0, 0, 1.2] },
    );
    const m = simulate(s.doc, range(2, 120)).get(120)!.get(ball)!;
    let lowest = Infinity;
    for (let i = 0; i < uv.positions.length; i += 3) {
      const [x, y, z] = uv.positions.slice(i, i + 3);
      lowest = Math.min(lowest, m[2] * x + m[6] * y + m[10] * z + m[14]);
    }
    expect(Math.abs(lowest)).toBeLessThan(2e-3);
    expect(m[14]).toBeCloseTo(1, 2);

    // a ramp tilted down towards +X: the ball rolls straight down it, one radius above it
    const r = physicsScene();
    const theta = 0.15;
    r.add('Ramp', r.plane(60), rb('PASSIVE'), { rotation_euler: [0, theta, 0] });
    const roller = r.add(
      'Ball',
      r.mesh('uv', () => uv),
      rb('ACTIVE', noDamping),
      {
        location: [Math.sin(theta) * 1.001, 0, Math.cos(theta) * 1.001],
      },
    );
    const frames = range(2, 49);
    const res = simulate(r.doc, frames);
    for (const f of frames) {
      const p = loc(res.get(f)!.get(roller)!);
      expect(Math.abs(p[1])).toBeLessThan(1e-3);
      expect(p[0] * Math.sin(theta) + p[2] * Math.cos(theta)).toBeGreaterThan(0.99);
    }
    const p = loc(res.get(49)!.get(roller)!);
    const along = (p[0] - Math.sin(theta)) * Math.cos(theta) - (p[2] - Math.cos(theta)) * Math.sin(theta);
    const t = 48 / FPS;
    // rolling without slipping (5/7 g sin θ); the facets cost a little
    expect(along / (0.5 * (5 / 7) * G * Math.sin(theta) * t * t)).toBeGreaterThan(0.93);
  });

  it('rests convex hulls on triangle meshes and settles in a concave valley', () => {
    const s = physicsScene();
    const grid = s.mesh('Grid', () => createGrid({ x_subdivisions: 12, y_subdivisions: 12, size: 12 }));
    s.add('Ground', grid, rb('PASSIVE')); // MESH shape (Blender default for PASSIVE)
    const icoMesh = createIcoSphere({ subdivisions: 2, radius: 0.5 });
    const ico = s.add(
      'Ico',
      s.mesh('Ico', () => icoMesh),
      rb('ACTIVE'),
      {
        location: [0.37, -0.21, 1.5],
        rotation_euler: [0.4, 0.1, 0.3],
      },
    );
    // V-shaped valley: two 30° slopes meeting at x = 0
    const h = 2 * Math.tan(Math.PI / 6);
    const valley = createMesh({
      positions: [-2, -2, h, 0, -2, 0, 0, 2, 0, -2, 2, h, 2, -2, h, 2, 2, h],
      faces: [
        [0, 1, 2, 3],
        [1, 4, 5, 2],
      ],
    });
    s.add(
      'Valley',
      s.mesh('Valley', () => valley),
      rb('PASSIVE'),
      { location: [6, 0, 0] },
    );
    const box = s.add('Box', s.cube(0.4), rb('ACTIVE'), {
      location: [7.2, 0.1, 1.2],
      rotation_euler: [0, 0, 0.2],
    });
    const res = simulate(s.doc, range(2, 200));
    const m = res.get(200)!.get(ico)!;
    let lowest = Infinity;
    for (let i = 0; i < icoMesh.positions.length; i += 3) {
      const [x, y, z] = icoMesh.positions.slice(i, i + 3);
      lowest = Math.min(lowest, m[2] * x + m[6] * y + m[10] * z + m[14]);
    }
    expect(Math.abs(lowest)).toBeLessThan(4e-3);
    expect(loc(res.get(199)!.get(ico)!)).toEqual(loc(m)); // at rest
    const b = loc(res.get(200)!.get(box)!);
    expect(Math.abs(b[0] - 6)).toBeLessThan(0.25); // slid down into the valley
    expect(b[2]).toBeGreaterThan(0.1);
    expect(b[2]).toBeLessThan(0.45);
  });

  it('fits the primitive shapes to the object bounds', () => {
    const s = physicsScene();
    s.ground();
    const shapes = ['BOX', 'SPHERE', 'CYLINDER', 'CONE', 'CAPSULE', 'CONVEX_HULL'] as const;
    const ids = shapes.map((shape, i) =>
      s.add(shape, s.cube(1), rb('ACTIVE', { collision_shape: shape }), { location: [i * 3 - 7, 0, 2] }),
    );
    const res = simulate(s.doc, [120]);
    ids.forEach((id) => expect(loc(res.get(120)!.get(id)!)[2]).toBeCloseTo(0.5, 2));
  });
});

describe('kinematic and frozen bodies', () => {
  it('pushes dynamic bodies with an animated (kinematic) passive body', () => {
    const s = physicsScene();
    s.ground({}, 40);
    const pusher = s.add('Pusher', s.cube(1), rb('PASSIVE', { kinematic: true, collision_shape: 'BOX' }), {
      location: [-2, 0, 0.5],
    });
    s.doc.setFCurve({
      target_type: 'object',
      target_id: pusher,
      path: 'location',
      index: 0,
      keyframes: [
        { frame: 1, value: -2, interpolation: 'LINEAR' },
        { frame: 49, value: 2, interpolation: 'LINEAR' },
      ],
      extrapolation: 'CONSTANT',
      mute: false,
    });
    const box = s.add('Box', s.cube(1), rb('ACTIVE', { collision_shape: 'BOX' }), { location: [0, 0, 0.5] });
    const frames = range(2, 120);
    const res = simulate(s.doc, frames);
    for (const f of frames) {
      const m = res.get(f)!;
      expect(m.has(pusher)).toBe(false); // animated bodies keep their own transforms
      const px = -2 + (4 * Math.min(f - 1, 48)) / 48;
      expect(loc(m.get(box)!)[0] - px).toBeGreaterThan(1 - 0.01); // never pushed into the pusher
    }
    expect(loc(res.get(24)!.get(box)!)[0]).toBeGreaterThan(0.8);
    const end = loc(res.get(120)!.get(box)!)[0];
    // keeps sliding after the pusher stops (2 m/s, friction 0.25)
    expect(end).toBeGreaterThan(3.6);
    expect(end).toBeLessThan(3.85);
    expect(loc(res.get(119)!.get(box)!)[0]).toBe(end);
  });

  it('keeps ACTIVE bodies with Dynamic off at their start pose as colliders', () => {
    const s = physicsScene();
    const shelf = s.add('Shelf', s.cube(1), rb('ACTIVE', { enabled: false, collision_shape: 'BOX' }), {
      location: [0, 0, 2],
    });
    const box = s.add('Box', s.cube(1), rb('ACTIVE', { collision_shape: 'BOX' }), { location: [0, 0, 4] });
    const res = simulate(s.doc, [60]);
    expect(loc(res.get(60)!.get(shelf)!)).toEqual([0, 0, 2]);
    expect(loc(res.get(60)!.get(box)!)[2]).toBeCloseTo(3, 2);
  });
});

describe('determinism, sleeping and robustness', () => {
  it('produces identical results for identical inputs, independent of creation order', () => {
    const build = (reverse: boolean) => {
      const doc = SceneDoc.create({ empty: true });
      const cube = doc.addMesh('Cube', createCube({ size: 1 }));
      const plane = doc.addMesh('Plane', createPlane({ size: 20 }));
      const specs: [string, () => void][] = [
        ['g', () => doc.addObject({ type: 'MESH', name: 'G', data: plane, rigid_body: rb('PASSIVE') }, 'g')],
        ...range(0, 5).map((i): [string, () => void] => [
          `b${i}`,
          () =>
            doc.addObject(
              {
                type: 'MESH',
                name: `B${i}`,
                data: cube,
                location: [Math.sin(i) * 0.3, Math.cos(i * 2) * 0.3, 1 + i * 1.1],
                rotation_euler: [i * 0.3, i * 0.2, i * 0.1],
                rigid_body: rb('ACTIVE'),
              },
              `b${i}`,
            ),
        ]),
      ];
      (reverse ? [...specs].reverse() : specs).forEach(([, add]) => add());
      return doc;
    };
    const a = simulate(build(false), range(2, 90));
    const b = simulate(build(true), range(2, 90));
    for (const f of range(2, 90)) for (const [id, m] of a.get(f)!) expect(b.get(f)!.get(id)).toEqual(m);
    // the bodies interacted (it is not a trivial run)
    expect(loc(a.get(90)!.get('b5')!)[2]).toBeLessThan(5);
  });

  it('wakes a sleeping stack when something hits it', () => {
    const s = physicsScene();
    s.ground();
    const bottom = s.add('Bottom', s.cube(1), rb('ACTIVE'), { location: [0, 0, 0.5] });
    const sim0 = directSimulation(s.doc);
    for (let f = 2; f <= 40; f++) sim0.advance(null);
    expect(sim0.outputs[0].awake).toBe(false);
    // a box dropped later (start high) lands on the sleeping one and pushes it down/aside
    s.add('Dropped', s.cube(1), rb('ACTIVE', { mass: 50 }), {
      location: [0.45, 0, 30],
      rotation_euler: [0.5, 0.3, 0],
    });
    const res = simulate(s.doc, range(2, 140));
    const before = loc(res.get(60)!.get(bottom)!);
    const after = loc(res.get(140)!.get(bottom)!);
    expect(Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2])).toBeGreaterThan(
      0.05,
    );
  });

  it('reports unusable objects instead of failing and simulates the rest', () => {
    const s = physicsScene();
    s.ground();
    const ok = s.add('Box', s.cube(1), rb('ACTIVE'), { location: [0, 0, 3] });
    const empty = s.doc.addObject({ type: 'EMPTY', name: 'Empty', rigid_body: rb('ACTIVE') });
    const noVerts = s.add(
      'NoVerts',
      s.mesh('Nothing', () => createMesh()),
      rb('ACTIVE'),
    );
    const nan = s.add('NaN', s.cube(1), rb('ACTIVE'), { location: [NaN, 0, 1] });
    const junk = s.add('Junk', s.cube(1), null, { location: [5, 0, 2] });
    s.doc.updateObject(junk, {
      rigid_body: {
        type: 'ACTIVE',
        mass: 'heavy',
        friction: -3,
        collision_shape: 'BLOB',
      } as unknown as RigidBodyData,
    });
    const meshActive = s.add('MeshActive', s.cube(1), rb('ACTIVE', { collision_shape: 'MESH' }), {
      location: [-5, 0, 2],
    });
    const sim = new RigidBodySimulator();
    const out = sim.evaluate(s.doc, 100, hostOf(s.doc))!;
    expect(loc(out.get(ok)!)[2]).toBeCloseTo(0.5, 2);
    expect(loc(out.get(junk)!)[2]).toBeCloseTo(0.5, 2); // sanitized to Blender defaults
    expect(loc(out.get(meshActive)!)[2]).toBeCloseTo(0.5, 2);
    for (const id of [empty, noVerts, nan]) expect(out.has(id)).toBe(false);
    const issues = sim.issues;
    const levels = (id: string) => issues.filter((i) => i.objectId === id).map((i) => i.level);
    expect(levels(empty)).toEqual(['ERROR']);
    expect(levels(noVerts)).toEqual(['ERROR']);
    expect(levels(nan)).toEqual(['ERROR']);
    expect(levels(meshActive)).toEqual(['WARNING']);
    expect(issues.find((i) => i.objectId === meshActive)!.message).toMatch(/CONVEX_HULL/);
  });

  it('simulates flat, collinear, scaled and mirrored meshes', () => {
    const s = physicsScene();
    s.ground();
    const flat = s.add('Flat', s.plane(1), rb('ACTIVE'), {
      location: [0, 0, 1],
      rotation_euler: [0.2, 0, 0],
    });
    const line = s.add(
      'Line',
      s.mesh('Line', () => createMesh({ positions: [-0.5, 0, 0, 0.5, 0, 0] })),
      rb('ACTIVE'),
      {
        location: [3, 0, 1],
      },
    );
    const scaled = s.add('Scaled', s.cube(1), rb('ACTIVE', { collision_shape: 'BOX' }), {
      location: [-3, 0, 2],
      scale: [2, 1, 0.5],
    });
    const mirrored = s.add('Mirrored', s.cube(1), rb('ACTIVE'), { location: [6, 0, 2], scale: [-1, 1, 1] });
    const res = simulate(s.doc, [150]).get(150)!;
    // flat and collinear meshes collide as 1 cm thick slabs / rods
    expect(loc(res.get(flat)!)[2]).toBeCloseTo(0.005, 2);
    expect(loc(res.get(line)!)[2]).toBeCloseTo(0.005, 2);
    const sm = res.get(scaled)!;
    expect(loc(sm)[2]).toBeCloseTo(0.25, 2);
    // the object's scale is kept in the simulated matrix
    expect(Math.hypot(sm[0], sm[1], sm[2])).toBeCloseTo(2, 9);
    expect(Math.hypot(sm[4], sm[5], sm[6])).toBeCloseTo(1, 9);
    expect(Math.hypot(sm[8], sm[9], sm[10])).toBeCloseTo(0.5, 9);
    const mm = res.get(mirrored)!;
    const det =
      mm[0] * (mm[5] * mm[10] - mm[6] * mm[9]) -
      mm[4] * (mm[1] * mm[10] - mm[2] * mm[9]) +
      mm[8] * (mm[1] * mm[6] - mm[2] * mm[5]);
    expect(det).toBeCloseTo(-1, 9);
    expect(loc(mm)[2]).toBeCloseTo(0.5, 2);
  });
});
