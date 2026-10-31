import { describe, expect, it } from 'vitest';
import {
  MAX_INSTANCES,
  compose4,
  multiply4,
  ParticleSettingsSchema,
  SceneDoc,
  SceneEvaluator,
  createCube,
  createGrid,
  createMesh,
  createPlane,
  createUVSphere,
  encodeFloat32,
  expandInstances,
  newId,
  normalizeParticleSettings,
  type EvaluatedInstance,
  type Mat4,
  type MeshData,
  type ParticleSettings,
  type ParticleSystemData,
  type Vec3,
} from '../src';

// ------------------------------------------------------------------ helpers

const col = (m: Mat4, c: number): Vec3 => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
const pos = (m: Mat4): Vec3 => [m[12], m[13], m[14]];
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const unit = (v: Vec3): Vec3 => {
  const l = len(v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function meshObject(
  doc: SceneDoc,
  name: string,
  mesh: MeshData,
  init: { location?: Vec3; rotation?: Vec3; scale?: Vec3; collection?: string } = {},
): string {
  return doc.addObject({
    type: 'MESH',
    name,
    data: doc.addMesh(name, mesh),
    location: init.location ?? [0, 0, 0],
    rotation_euler: init.rotation ?? [0, 0, 0],
    scale: init.scale ?? [1, 1, 1],
    ...(init.collection ? { collection: init.collection } : {}),
  });
}

function addSystem(
  doc: SceneDoc,
  emitter: string,
  settings: Partial<ParticleSettings>,
  extra: Partial<ParticleSystemData> = {},
): string {
  const o = doc.getObject(emitter)!;
  const ps: ParticleSystemData = {
    id: newId(),
    name: `P${o.particle_systems.length}`,
    show_viewport: true,
    show_render: true,
    settings: { ...settings },
    ...extra,
  };
  doc.updateObject(emitter, { particle_systems: [...o.particle_systems, ps] });
  return ps.id;
}

function updateSettings(doc: SceneDoc, emitter: string, patch: Partial<ParticleSettings>): void {
  const o = doc.getObject(emitter)!;
  doc.updateObject(emitter, {
    particle_systems: o.particle_systems.map((p, i) =>
      i === 0 ? { ...p, settings: { ...p.settings, ...patch } } : p,
    ),
  });
}

/** A scene with a 2×2 plane emitter (z = 0) and a hidden unit cube to instance. */
function basic(settings: Partial<ParticleSettings> = {}, emitterMesh: MeshData = createPlane({ size: 2 })) {
  const doc = SceneDoc.create({ empty: true });
  const cube = meshObject(doc, 'Cube', createCube({ size: 0.2 }), { location: [50, 50, 50] });
  doc.updateObject(cube, { hide_viewport: true, hide_render: true });
  const emitter = meshObject(doc, 'Ground', emitterMesh);
  const ps = addSystem(doc, emitter, { instance_object: cube, ...settings });
  return { doc, cube, emitter, ps };
}

function instancesOf(doc: SceneDoc, owner: string, forRender = false, frame = 1): EvaluatedInstance[] {
  return new SceneEvaluator(doc).evaluate(frame, { forRender }).instances.filter((i) => i.ownerId === owner);
}

/** Instances of an owner, asserting how many there are. */
function expectInstances(
  doc: SceneDoc,
  owner: string,
  count: number,
  forRender = false,
): EvaluatedInstance[] {
  const list = instancesOf(doc, owner, forRender);
  expect(list).toHaveLength(count);
  return list;
}

function errorsOf(doc: SceneDoc, owner: string, forRender = false): string[] {
  return new SceneEvaluator(doc)
    .evaluate(1, { forRender })
    .errors.filter((e) => e.source === `instances:${owner}`)
    .map((e) => e.message);
}

/** Mesh of two separate quads with areas 1 (x 0..1) and 9 (x 1..10). */
function twoQuads(): MeshData {
  return createMesh({
    positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 10, 0, 0, 10, 1, 0, 1, 1, 0],
    faces: [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ],
  });
}

// ------------------------------------------------------------------ settings

describe('particle settings', () => {
  it('validates and defaults with Blender-like names', () => {
    const d = ParticleSettingsSchema.parse({});
    expect(d).toMatchObject({
      count: 1000,
      seed: 0,
      emit_from: 'FACE',
      distribution: 'JITTERED',
      use_even_distribution: true,
      instance_type: 'OBJECT',
      particle_size: 1,
      rotation_mode: 'NORMAL',
      use_scale_instance: true,
      use_rotation_instance: false,
      display_percentage: 100,
    });
    expect(ParticleSettingsSchema.safeParse({ count: -1 }).success).toBe(false);
    expect(ParticleSettingsSchema.safeParse({ count: MAX_INSTANCES + 1 }).success).toBe(false);
    expect(ParticleSettingsSchema.safeParse({ distribution: 'POISSON' }).success).toBe(false);
  });

  it('normalizes stored data leniently (aliases, animated numbers, invalid values)', () => {
    const { settings, errors } = normalizeParticleSettings({
      count: 10.6,
      distribution: 'JIT',
      rotation_mode: 'nor_tan',
      size_random: 3,
      use_scale_instance: 0.2,
      emit_from: 42,
      unknown_field: 1,
    });
    expect(settings.count).toBe(11);
    expect(settings.distribution).toBe('JITTERED');
    expect(settings.rotation_mode).toBe('NORMAL_TANGENT');
    expect(settings.size_random).toBe(1);
    expect(settings.use_scale_instance).toBe(false);
    expect(settings.emit_from).toBe('FACE');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/emit_from/);
    expect(normalizeParticleSettings(null).settings.count).toBe(1000);
  });
});

// ------------------------------------------------------------------ distribution

describe('particle distribution', () => {
  it('scatters count instances of the instance object over the surface', () => {
    const { doc, cube, emitter, ps } = basic({ count: 100 });
    const inst = instancesOf(doc, emitter);
    expect(inst).toHaveLength(100);
    for (const i of inst) {
      expect(i.sourceId).toBe(cube);
      expect(i.id.startsWith(`${emitter}:${ps}:`)).toBe(true);
      const p = pos(i.matrix);
      expect(Math.abs(p[0])).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.abs(p[1])).toBeLessThanOrEqual(1 + 1e-9);
      expect(p[2]).toBeCloseTo(0, 12);
    }
    expect(new Set(inst.map((i) => i.id)).size).toBe(100);
    expect(errorsOf(doc, emitter)).toEqual([]);
  });

  it('is deterministic per seed and independent of object ids', () => {
    for (const distribution of ['RANDOM', 'JITTERED'] as const) {
      const s1 = basic({ count: 40, seed: 7, distribution });
      const s2 = basic({ count: 40, seed: 7, distribution });
      const s3 = basic({ count: 40, seed: 8, distribution });
      const m1 = instancesOf(s1.doc, s1.emitter).map((i) => i.matrix);
      const m2 = instancesOf(s2.doc, s2.emitter).map((i) => i.matrix);
      const m3 = instancesOf(s3.doc, s3.emitter).map((i) => i.matrix);
      expect(m2).toEqual(m1);
      expect(m3).not.toEqual(m1);
    }
  });

  it('keeps existing particles in place when the count changes', () => {
    for (const distribution of ['RANDOM', 'JITTERED'] as const) {
      const { doc, emitter } = basic({ count: 50, distribution, seed: 3 });
      const before = new Map(instancesOf(doc, emitter).map((i) => [i.id, i.matrix]));
      updateSettings(doc, emitter, { count: 80 });
      const after = instancesOf(doc, emitter);
      expect(after).toHaveLength(80);
      let same = 0;
      for (const i of after)
        if (before.has(i.id)) {
          expect(i.matrix).toEqual(before.get(i.id));
          same++;
        }
      expect(same).toBe(50);
    }
  });

  it('distributes by face area with use_even_distribution, per face without', () => {
    const left = (inst: EvaluatedInstance[]) => inst.filter((i) => pos(i.matrix)[0] < 1).length;
    const even = basic({ count: 1000, distribution: 'JITTERED' }, twoQuads());
    expect(Math.abs(left(instancesOf(even.doc, even.emitter)) - 100)).toBeLessThanOrEqual(3);
    const random = basic({ count: 2000, distribution: 'RANDOM', seed: 11 }, twoQuads());
    expect(Math.abs(left(instancesOf(random.doc, random.emitter)) - 200)).toBeLessThan(45);
    const perFace = basic({ count: 1000, use_even_distribution: false }, twoQuads());
    expect(Math.abs(left(instancesOf(perFace.doc, perFace.emitter)) - 500)).toBeLessThanOrEqual(3);
  });

  it('covers the surface evenly with JITTERED', () => {
    const { doc, emitter } = basic(
      { count: 400, distribution: 'JITTERED' },
      createGrid({ x_subdivisions: 4, y_subdivisions: 4, size: 2 }),
    );
    const inst = instancesOf(doc, emitter);
    const cells = new Map<string, number>();
    for (const i of inst) {
      const p = pos(i.matrix);
      const k = `${Math.min(3, Math.floor((p[0] + 1) * 2))},${Math.min(3, Math.floor((p[1] + 1) * 2))}`;
      cells.set(k, (cells.get(k) ?? 0) + 1);
    }
    expect(cells.size).toBe(16);
    for (const n of cells.values()) expect(Math.abs(n - 25)).toBeLessThanOrEqual(2);
  });

  it('scales density by a vertex group (and its inverse)', () => {
    const grid = createGrid({ x_subdivisions: 10, y_subdivisions: 10, size: 2 });
    const weights: number[] = [];
    for (let v = 0; v < grid.positions.length / 3; v++) weights.push(grid.positions[v * 3] < -1e-9 ? 1 : 0);
    const { doc, emitter } = basic({ count: 300, vertex_group_density: 'Left' }, grid);
    doc.setVertexGroups(doc.getObject(emitter)!.data!, [{ name: 'Left', weights: encodeFloat32(weights) }]);
    const inst = instancesOf(doc, emitter);
    expect(inst).toHaveLength(300);
    expect(Math.max(...inst.map((i) => pos(i.matrix)[0]))).toBeLessThanOrEqual(1e-9);
    updateSettings(doc, emitter, { invert_vertex_group_density: true });
    const inv = instancesOf(doc, emitter);
    expect(Math.min(...inv.map((i) => pos(i.matrix)[0]))).toBeGreaterThanOrEqual(-0.2 - 1e-9);
    updateSettings(doc, emitter, { vertex_group_density: 'Nope' });
    expect(errorsOf(doc, emitter).join()).toMatch(/vertex group 'Nope' not found/);
    expect(instancesOf(doc, emitter)).toHaveLength(300);
  });

  it('keeps a minimum world-space distance between particles', () => {
    const { doc, emitter } = basic({ count: 150, min_distance: 0.12, distribution: 'RANDOM' });
    const check = (min: number) => {
      const p = instancesOf(doc, emitter).map((i) => pos(i.matrix));
      for (let a = 0; a < p.length; a++)
        for (let b = a + 1; b < p.length; b++)
          expect(len([p[a][0] - p[b][0], p[a][1] - p[b][1], p[a][2] - p[b][2]])).toBeGreaterThanOrEqual(
            min - 1e-9,
          );
      return p.length;
    };
    expect(check(0.12)).toBe(150);
    // world units: a scaled emitter keeps the same spacing in world space
    doc.updateObject(emitter, { scale: [3, 0.5, 1], rotation_euler: [0, 0, 0.8] });
    expect(check(0.12)).toBe(150);
    // a full surface places fewer particles and says so
    updateSettings(doc, emitter, { count: 500, min_distance: 0.5 });
    const placed = check(0.5);
    expect(placed).toBeLessThan(500);
    expect(placed).toBeGreaterThan(5);
    expect(errorsOf(doc, emitter).join()).toMatch(/min_distance 0.5: placed only \d+ of 500/);
  });

  it('emits from vertices', () => {
    const grid = createGrid({ x_subdivisions: 4, y_subdivisions: 4, size: 2 });
    const verts = new Set<string>();
    for (let v = 0; v < grid.positions.length / 3; v++)
      verts.add(`${grid.positions[v * 3].toFixed(6)},${grid.positions[v * 3 + 1].toFixed(6)}`);
    const { doc, emitter } = basic({ count: 25, emit_from: 'VERT', distribution: 'JITTERED' }, grid);
    const once = instancesOf(doc, emitter).map(
      (i) => `${i.matrix[12].toFixed(6)},${i.matrix[13].toFixed(6)}`,
    );
    expect(new Set(once)).toEqual(verts); // count = vertex count: every vertex exactly once
    updateSettings(doc, emitter, { count: 200, distribution: 'RANDOM' });
    const many = instancesOf(doc, emitter);
    expect(many).toHaveLength(200);
    for (const i of many)
      expect(verts.has(`${i.matrix[12].toFixed(6)},${i.matrix[13].toFixed(6)}`)).toBe(true);
  });

  it('emits inside closed volumes', () => {
    const { doc, emitter } = basic(
      { count: 300, emit_from: 'VOLUME' },
      createUVSphere({ radius: 1, segments: 24, ring_count: 12 }),
    );
    const p = instancesOf(doc, emitter).map((i) => pos(i.matrix));
    expect(p).toHaveLength(300);
    for (const q of p) expect(len(q)).toBeLessThan(1);
    expect(p.filter((q) => len(q) < 0.6).length).toBeGreaterThan(30); // not only near the surface
    for (const distribution of ['RANDOM', 'GRID'] as const) {
      updateSettings(doc, emitter, { distribution, grid_resolution: 6 });
      const r = instancesOf(doc, emitter).map((i) => pos(i.matrix));
      expect(r.length).toBeGreaterThan(distribution === 'GRID' ? 50 : 299);
      for (const q of r) expect(len(q)).toBeLessThan(1);
    }
    const flat = basic({ count: 10, emit_from: 'VOLUME' });
    expect(instancesOf(flat.doc, flat.emitter)).toHaveLength(0);
    expect(errorsOf(flat.doc, flat.emitter).join()).toMatch(/VOLUME emission needs a closed mesh/);
  });

  it('places GRID particles on a regular lattice (count is ignored)', () => {
    const { doc, emitter } = basic({ count: 5, distribution: 'GRID', grid_resolution: 4 });
    const p = instancesOf(doc, emitter).map((i) => pos(i.matrix).map((x) => +x.toFixed(9)));
    expect(p).toHaveLength(16);
    const coords = [-0.75, -0.25, 0.25, 0.75];
    for (const x of coords) for (const y of coords) expect(p).toContainEqual([x, y, 0]);
    const cube = basic({ distribution: 'GRID', grid_resolution: 4 }, createCube({ size: 2 }));
    const onSurface = instancesOf(cube.doc, cube.emitter).map((i) => pos(i.matrix));
    expect(onSurface.length).toBeGreaterThan(40);
    for (const q of onSurface) expect(Math.max(...q.map(Math.abs))).toBeCloseTo(1, 9);
    updateSettings(cube.doc, cube.emitter, { emit_from: 'VOLUME' });
    expect(instancesOf(cube.doc, cube.emitter)).toHaveLength(64);
    updateSettings(cube.doc, cube.emitter, { emit_from: 'FACE', grid_random: 0.5 });
    const jittered = instancesOf(cube.doc, cube.emitter);
    expect(jittered.length).toBeGreaterThan(40);
    for (const i of jittered) expect(Math.max(...pos(i.matrix).map(Math.abs))).toBeCloseTo(1, 9);
    expect(jittered.map((i) => pos(i.matrix))).not.toEqual(onSurface); // grid_random moves the points
  });

  it('honours display_percentage in the viewport only, and show_viewport/show_render', () => {
    const { doc, emitter, ps } = basic({ count: 1000, display_percentage: 30 });
    const vp = instancesOf(doc, emitter);
    expect(Math.abs(vp.length - 300)).toBeLessThan(60);
    expect(instancesOf(doc, emitter, true)).toHaveLength(1000);
    // every particle shown in the viewport is a render particle with the same transform
    const full = new Map(instancesOf(doc, emitter, true).map((i) => [i.id, i.matrix]));
    for (const i of vp) expect(full.get(i.id)).toEqual(i.matrix);
    const ev = new SceneEvaluator(doc).evaluate(1);
    expect(
      expandInstances({
        doc,
        frame: 1,
        forRender: false,
        fullDisplay: true,
        objects: ev.objects,
        byId: ev.byId,
      }).instances,
    ).toHaveLength(1000);
    const o = doc.getObject(emitter)!;
    doc.updateObject(emitter, {
      particle_systems: o.particle_systems.map((p) => ({ ...p, show_viewport: false })),
    });
    expect(instancesOf(doc, emitter)).toHaveLength(0);
    expect(instancesOf(doc, emitter, true)).toHaveLength(1000);
    doc.updateObject(emitter, {
      particle_systems: o.particle_systems.map((p) => ({ ...p, show_viewport: true, show_render: false })),
    });
    expect(instancesOf(doc, emitter, true)).toHaveLength(0);
    expect(ps).toBeTruthy();
  });

  it('emits from the evaluated mesh, or the original mesh following deform modifiers', () => {
    const lift = {
      id: 'lift',
      name: 'Lift',
      type: 'DISPLACE',
      show_viewport: true,
      show_render: true,
      show_in_editmode: true,
      show_expanded: true,
      params: { texture_type: 'NONE', direction: 'Z', strength: 1, mid_level: 0.5 },
    };
    const subsurf = { ...lift, id: 'sub', name: 'Subdivision', type: 'SUBSURF', params: { levels: 1 } };
    const { doc, emitter } = basic({ count: 30 }, createGrid({ x_subdivisions: 2, y_subdivisions: 2 }));
    doc.updateObject(emitter, { modifiers: [lift] });
    for (const use_modifier_stack of [true, false]) {
      updateSettings(doc, emitter, { use_modifier_stack });
      for (const i of expectInstances(doc, emitter, 30)) expect(i.matrix[14]).toBeCloseTo(0.5, 9);
    }
    doc.updateObject(emitter, { modifiers: [subsurf, lift] });
    updateSettings(doc, emitter, { use_modifier_stack: true });
    for (const i of expectInstances(doc, emitter, 30)) expect(i.matrix[14]).toBeCloseTo(0.5, 9);
    updateSettings(doc, emitter, { use_modifier_stack: false });
    for (const i of expectInstances(doc, emitter, 30)) expect(i.matrix[14]).toBeCloseTo(0, 9);
  });

  it('follows animated settings (F-curves on particle_systems["…"] paths)', () => {
    const { doc, emitter } = basic({ count: 10 });
    doc.setFCurve({
      target_type: 'object',
      target_id: emitter,
      path: 'particle_systems["P0"].count',
      index: 0,
      keyframes: [
        { frame: 1, value: 10, interpolation: 'LINEAR' },
        { frame: 11, value: 110, interpolation: 'LINEAR' },
      ],
      extrapolation: 'CONSTANT',
      mute: false,
    });
    const evaluator = new SceneEvaluator(doc);
    const at = (f: number) => evaluator.evaluate(f).instances.filter((i) => i.ownerId === emitter).length;
    expect(at(1)).toBe(10);
    expect(at(6)).toBe(60);
    expect(at(6.04)).toBe(60); // fractional counts round
    expect(at(11)).toBe(110);
  });
});

// ------------------------------------------------------------------ placement

describe('particle placement', () => {
  it('aligns +Z with the surface normal (NORMAL) or world up (GLOBAL_Z)', () => {
    const sphere = createUVSphere({ radius: 1, segments: 32, ring_count: 16 });
    const { doc, emitter } = basic({ count: 200, rotation_mode: 'NORMAL' }, sphere);
    for (const i of expectInstances(doc, emitter, 200)) {
      const z = unit(col(i.matrix, 2));
      expect(dot(z, unit(pos(i.matrix)))).toBeGreaterThan(0.98);
      // orthonormal frame scaled by particle_size
      expect(len(col(i.matrix, 0))).toBeCloseTo(1, 9);
      expect(dot(unit(col(i.matrix, 0)), z)).toBeCloseTo(0, 9);
    }
    // smooth shading interpolates vertex normals: still outward
    doc.setMesh(doc.getObject(emitter)!.data!, { ...sphere, faceSmooth: sphere.faces.map(() => true) });
    for (const i of expectInstances(doc, emitter, 200))
      expect(dot(unit(col(i.matrix, 2)), unit(pos(i.matrix)))).toBeGreaterThan(0.99);
    // the emitter's rotation carries the normals along
    doc.updateObject(emitter, { rotation_euler: [0.7, 0.2, 1.1], location: [5, 0, 0] });
    for (const i of expectInstances(doc, emitter, 200)) {
      const p = pos(i.matrix);
      expect(dot(unit(col(i.matrix, 2)), unit([p[0] - 5, p[1], p[2]]))).toBeGreaterThan(0.99);
    }
    updateSettings(doc, emitter, { rotation_mode: 'GLOBAL_Z' });
    for (const i of expectInstances(doc, emitter, 200)) {
      expect(col(i.matrix, 2).map((x) => +x.toFixed(9))).toEqual([0, 0, 1]);
      expect(len(col(i.matrix, 1))).toBeCloseTo(1, 9);
    }
  });

  it('keeps the emitter heading on flat ground (NONE, NORMAL) and follows UV tangents (NORMAL_TANGENT)', () => {
    const { doc, emitter } = basic({ count: 20, rotation_mode: 'NORMAL' });
    doc.updateObject(emitter, { rotation_euler: [0, 0, 0.6] });
    const heading: Vec3 = [Math.cos(0.6), Math.sin(0.6), 0];
    for (const mode of ['NONE', 'NORMAL', 'NORMAL_TANGENT'] as const) {
      updateSettings(doc, emitter, { rotation_mode: mode });
      for (const i of expectInstances(doc, emitter, 20)) {
        expect(dot(unit(col(i.matrix, 0)), heading)).toBeCloseTo(1, 9);
        expect(col(i.matrix, 2).map((x) => +x.toFixed(9))).toEqual([0, 0, 1]);
      }
    }
    // NORMAL_TANGENT uses the UV U direction: rotate the UVs by 90° → X follows +Y of the mesh
    const plane = createPlane({ size: 2 });
    plane.uvs = [[0, 1, 0, 0, 1, 0, 1, 1]];
    doc.setMesh(doc.getObject(emitter)!.data!, plane);
    doc.updateObject(emitter, { rotation_euler: [0, 0, 0] });
    updateSettings(doc, emitter, { rotation_mode: 'NORMAL_TANGENT' });
    for (const i of expectInstances(doc, emitter, 20))
      expect(dot(unit(col(i.matrix, 0)), [0, 1, 0])).toBeCloseTo(1, 9);
  });

  it('applies phase, random phase and random rotation', () => {
    const { doc, emitter } = basic({ count: 50, phase_factor: 0.5 });
    for (const i of expectInstances(doc, emitter, 50))
      expect(col(i.matrix, 0).map((x) => +x.toFixed(9))).toEqual([0, 1, 0]);
    updateSettings(doc, emitter, { phase_factor: 0, phase_factor_random: 2 });
    const headings = instancesOf(doc, emitter).map((i) => Math.atan2(i.matrix[1], i.matrix[0]));
    expect(Math.max(...headings) - Math.min(...headings)).toBeGreaterThan(5);
    for (const i of expectInstances(doc, emitter, 50)) expect(i.matrix[10]).toBeCloseTo(1, 9); // still upright
    updateSettings(doc, emitter, { phase_factor_random: 0, rotation_factor_random: 1, count: 400 });
    const ups = instancesOf(doc, emitter).map((i) => unit(col(i.matrix, 2))[2]);
    const mean = ups.reduce((a, b) => a + b, 0) / ups.length;
    expect(Math.abs(mean)).toBeLessThan(0.15); // uniformly random orientations
    updateSettings(doc, emitter, { rotation_factor_random: 0.1 });
    for (const z of expectInstances(doc, emitter, 400).map((i) => unit(col(i.matrix, 2))[2]))
      expect(z).toBeGreaterThan(0.8);
  });

  it('equals emitter world × object-space frame for moved, rotated and uniformly scaled emitters', () => {
    for (const rotation_mode of ['NORMAL', 'NONE', 'NORMAL_TANGENT'] as const) {
      const { doc, emitter } = basic(
        { count: 30, rotation_mode, particle_size: 0.5, size_random: 0.5, phase_factor_random: 2 },
        createUVSphere({ radius: 1, segments: 12, ring_count: 6 }),
      );
      const local = new Map(instancesOf(doc, emitter).map((i) => [i.id, i.matrix]));
      expect(local.size).toBe(30);
      doc.updateObject(emitter, {
        location: [1, 2, 3],
        rotation_euler: [0.3, -0.2, 1.1],
        scale: [2.5, 2.5, 2.5],
      });
      const E = compose4([1, 2, 3], [0.3, -0.2, 1.1], [2.5, 2.5, 2.5]);
      const moved = expectInstances(doc, emitter, 30);
      for (const i of moved) {
        const expected = multiply4(E, local.get(i.id)!);
        for (let k = 0; k < 16; k++) expect(i.matrix[k]).toBeCloseTo(expected[k], 9);
      }
    }
  });

  it('sizes instances by particle_size/size_random, not by the emitter scale', () => {
    const { doc, cube, emitter } = basic({ count: 100, particle_size: 0.5, size_random: 0.4 });
    doc.updateObject(emitter, { scale: [5, 5, 1] });
    const sizes = expectInstances(doc, emitter, 100).map((i) => len(col(i.matrix, 0)));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(0.3 - 1e-9);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeGreaterThan(0.15);
    for (const i of expectInstances(doc, emitter, 100)) {
      const s = [0, 1, 2].map((c) => len(col(i.matrix, c)));
      expect(s[1]).toBeCloseTo(s[0], 9);
      expect(s[2]).toBeCloseTo(s[0], 9);
      expect(Math.abs(i.matrix[12])).toBeLessThanOrEqual(5 + 1e-9); // positions do follow the scale
    }
    // the instanced object's own scale / rotation
    updateSettings(doc, emitter, { size_random: 0 });
    doc.updateObject(cube, { scale: [2, 2, 2], rotation_euler: [Math.PI / 2, 0, 0] });
    const first = () => instancesOf(doc, emitter)[0].matrix;
    expect(len(col(first(), 0))).toBeCloseTo(1, 9); // 0.5 × 2
    expect(unit(col(first(), 1)).map((x) => +x.toFixed(9))).toEqual([0, 1, 0]);
    updateSettings(doc, emitter, { use_rotation_instance: true });
    expect(unit(col(first(), 1)).map((x) => +x.toFixed(9))).toEqual([0, 0, 1]);
    updateSettings(doc, emitter, { use_scale_instance: false });
    expect(len(col(first(), 0))).toBeCloseTo(0.5, 9);
    expect(unit(col(first(), 1)).map((x) => +x.toFixed(9))).toEqual([0, 0, 1]);
  });

  it('instances collections: weighted random picks, ordered cycling and whole collections', () => {
    const doc = SceneDoc.create({ empty: true });
    const coll = doc.addCollection({ name: 'Rocks', instance_offset: [0, 0, 1], hide_viewport: true });
    const a = meshObject(doc, 'A', createCube({ size: 0.1 }), { collection: coll, location: [0, 0, 1] });
    const b = meshObject(doc, 'B', createCube({ size: 0.1 }), { collection: coll, location: [1, 0, 1] });
    const c = meshObject(doc, 'C', createCube({ size: 0.1 }), { collection: coll, location: [0, 1, 1] });
    doc.addObject({ type: 'LIGHT', name: 'Lamp', data: doc.addLight(), collection: coll });
    const emitter = meshObject(doc, 'Ground', createPlane({ size: 10 }), { collection: coll });
    addSystem(doc, emitter, {
      count: 3000,
      instance_type: 'COLLECTION',
      instance_collection: coll,
      use_collection_pick_random: true,
      instance_weights: [
        { object: a, weight: 2 },
        { object: c, weight: 0 },
      ],
    });
    const counts = (list: EvaluatedInstance[]) => {
      const m = new Map<string, number>();
      for (const i of list) m.set(i.sourceId, (m.get(i.sourceId) ?? 0) + 1);
      return m;
    };
    let inst = instancesOf(doc, emitter);
    let n = counts(inst);
    expect(n.get(c)).toBeUndefined();
    expect(n.get(emitter)).toBeUndefined(); // the emitter itself is never picked
    expect(Math.abs(n.get(a)! / 3000 - 2 / 3)).toBeLessThan(0.04);
    // placed at the particle (object origin at the particle, own location dropped)
    for (const i of inst) expect(i.matrix[14]).toBeCloseTo(0, 9);
    // in order: A, B, C, A, B, C … (weights act as repeat counts)
    updateSettings(doc, emitter, { use_collection_pick_random: false, instance_weights: [], count: 9 });
    inst = instancesOf(doc, emitter);
    expect(inst.map((i) => i.sourceId)).toEqual([a, b, c, a, b, c, a, b, c]);
    updateSettings(doc, emitter, { instance_weights: [{ object: a, weight: 2 }] });
    expect(instancesOf(doc, emitter).map((i) => i.sourceId)).toEqual([a, a, b, c, a, a, b, c, a]);
    // whole collection: every object at every particle, relative to the instance offset
    updateSettings(doc, emitter, { use_whole_collection: true, count: 5, rotation_mode: 'GLOBAL_Z' });
    inst = instancesOf(doc, emitter);
    expect(inst).toHaveLength(15);
    n = counts(inst);
    expect([n.get(a), n.get(b), n.get(c)]).toEqual([5, 5, 5]);
    const byParticle = new Map<string, EvaluatedInstance[]>();
    for (const i of inst) {
      const k = i.id.split(':').slice(0, 3).join(':');
      byParticle.set(k, [...(byParticle.get(k) ?? []), i]);
    }
    for (const group of byParticle.values()) {
      const pa = pos(group.find((i) => i.sourceId === a)!.matrix);
      const pb = pos(group.find((i) => i.sourceId === b)!.matrix);
      expect(pa[2]).toBeCloseTo(0, 9); // offset (0,0,1) removed
      expect(pb[0] - pa[0]).toBeCloseTo(1, 9);
    }
  });

  it('expands nested instancers used as instance objects', () => {
    const doc = SceneDoc.create({ empty: true });
    const inner = doc.addCollection({ name: 'Inner', hide_viewport: true });
    const k = meshObject(doc, 'K', createCube({ size: 0.1 }), { collection: inner, location: [0, 0, 1] });
    const empty = doc.addObject({
      type: 'EMPTY',
      name: 'Tree',
      instance_type: 'COLLECTION',
      instance_collection: inner,
      location: [20, 0, 0],
    });
    const emitter = meshObject(doc, 'Ground', createPlane({ size: 2 }));
    addSystem(doc, emitter, { count: 10, instance_object: empty, rotation_mode: 'GLOBAL_Z' });
    const inst = instancesOf(doc, emitter);
    expect(inst).toHaveLength(10);
    for (const i of inst) {
      expect(i.sourceId).toBe(k);
      expect(i.id).toMatch(new RegExp(`^${emitter}:[^:]+:\\d+:${empty}:${k}$`));
      expect(i.matrix[14]).toBeCloseTo(1, 9); // K sits 1 above the empty → 1 above the particle
      expect(Math.abs(i.matrix[12])).toBeLessThanOrEqual(1);
    }
  });

  it('reports problems without failing the evaluation', () => {
    const doc = SceneDoc.create({ empty: true });
    const emitter = meshObject(doc, 'Ground', createPlane());
    const empty = doc.addObject({ type: 'EMPTY', name: 'E' });
    const lamp = doc.addObject({ type: 'LIGHT', name: 'Lamp', data: doc.addLight() });
    addSystem(doc, emitter, { count: 5 }, { name: 'NoObject' });
    addSystem(doc, emitter, { count: 5, instance_object: 'missing' }, { name: 'Missing' });
    addSystem(doc, emitter, { count: 5, instance_object: lamp }, { name: 'Lamp' });
    addSystem(
      doc,
      emitter,
      { count: 5, instance_type: 'COLLECTION', instance_collection: 'nope' },
      { name: 'Coll' },
    );
    addSystem(doc, emitter, { count: 5, instance_type: 'NONE' }, { name: 'None' });
    addSystem(doc, empty, { count: 5, instance_object: emitter }, { name: 'OnEmpty' });
    const ev = new SceneEvaluator(doc).evaluate(1);
    expect(ev.instances).toEqual([]);
    const msgs = ev.errors.map((e) => e.message).join('\n');
    expect(msgs).toMatch(/'NoObject': no instance_object set/);
    expect(msgs).toMatch(/'Missing': instance object missing not found/);
    expect(msgs).toMatch(/'Lamp': instance object 'Lamp' \(LIGHT\) has no geometry/);
    expect(msgs).toMatch(/'Coll': instance collection nope not found/);
    expect(msgs).toMatch(/'OnEmpty': particle systems need a mesh, curve or text emitter/);
    expect(msgs).not.toMatch(/'None'/);
  });

  it('survives a snapshot round trip with identical instances', () => {
    const { doc, emitter } = basic({ count: 25, seed: 4, size_random: 0.3, phase_factor_random: 2 });
    const before = instancesOf(doc, emitter);
    const copy = SceneDoc.fromSnapshot(JSON.parse(JSON.stringify(doc.toSnapshot())));
    expect(copy.getObject(emitter)!.particle_systems[0].settings).toMatchObject({ count: 25, seed: 4 });
    expect(instancesOf(copy, emitter)).toEqual(before);
  });
});

// ------------------------------------------------------------------ robustness

describe('instancing robustness', () => {
  it('never throws for corrupt or degenerate data', () => {
    const doc = SceneDoc.create({ empty: true });
    const cube = meshObject(doc, 'Cube', createCube({ size: 0.1 }));
    const coll = doc.addCollection({ name: 'C', instance_offset: 'abc' as unknown as Vec3 });
    meshObject(doc, 'Member', createCube({ size: 0.1 }), { collection: coll, location: [1, 0, 0] });
    const inst = doc.addObject({
      type: 'EMPTY',
      name: 'Inst',
      instance_type: 'COLLECTION',
      instance_collection: coll,
    });
    const garbage = meshObject(doc, 'Garbage', createPlane());
    doc.updateObject(garbage, { particle_systems: 'garbage' as unknown as ParticleSystemData[] });
    const nullEntry = meshObject(doc, 'NullEntry', createPlane());
    doc.updateObject(nullEntry, {
      particle_systems: [null, { id: 'x', name: 'Bad', settings: 5 }] as unknown as ParticleSystemData[],
    });
    const nanEmitter = meshObject(doc, 'NaN', createPlane(), { location: [NaN, 0, 0] });
    addSystem(doc, nanEmitter, { count: 5, instance_object: cube });
    const broken = meshObject(
      doc,
      'Broken',
      createMesh({
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, NaN, 0, 0, 0, 1, 0],
        faces: [
          [0, 1, 2],
          [0, 2, 3],
          [0, 2, 9],
          [0, 4],
        ],
      }),
    );
    addSystem(doc, broken, { count: 20, instance_object: cube });
    const empty = meshObject(doc, 'NoFaces', createMesh({ positions: [0, 0, 0] }));
    addSystem(doc, empty, { count: 20, instance_object: cube });
    const zero = meshObject(doc, 'Zero', createPlane());
    addSystem(doc, zero, { count: 0, instance_object: cube });
    for (const forRender of [false, true]) {
      const ev = new SceneEvaluator(doc).evaluate(1, { forRender });
      const of = (id: string) => ev.instances.filter((i) => i.ownerId === id);
      expect(of(inst)).toHaveLength(1);
      expect(of(inst)[0].matrix.slice(12, 15)).toEqual([1, 0, 0]); // invalid offset → 0
      expect(of(garbage)).toEqual([]);
      expect(of(nullEntry)).toEqual([]);
      expect(of(nanEmitter)).toEqual([]);
      // only the valid triangle of the broken mesh is used
      const b = of(broken);
      expect(b).toHaveLength(20);
      for (const i of b) {
        expect(i.matrix.every(Number.isFinite)).toBe(true);
        expect(i.matrix[13]).toBeLessThanOrEqual(i.matrix[12] + 1e-9); // inside triangle (0,0)-(1,0)-(1,1)
      }
      expect(of(empty)).toEqual([]);
      expect(of(zero)).toEqual([]);
      const msgs = ev.errors.map((e) => e.message).join('\n');
      expect(msgs).toMatch(/'Bad': instance object|'Bad': no instance_object set/);
      expect(msgs).toMatch(/the emitter transform is not finite/);
      expect(msgs).toMatch(/no faces to emit from/);
      expect(ev.errors.filter((e) => e.source === `instances:${zero}`)).toEqual([]);
    }
  });

  it('keeps instance ids unique when a system id is duplicated on one object', () => {
    const { doc, cube, emitter } = basic({ count: 10 });
    const sys = doc.getObject(emitter)!.particle_systems[0];
    doc.updateObject(emitter, {
      particle_systems: [sys, { ...sys, name: 'Copy', settings: { ...sys.settings, seed: 9 } }],
    });
    const inst = instancesOf(doc, emitter);
    expect(inst).toHaveLength(20);
    expect(new Set(inst.map((i) => i.id)).size).toBe(20);
    expect(inst.every((i) => i.sourceId === cube)).toBe(true);
  });
});
