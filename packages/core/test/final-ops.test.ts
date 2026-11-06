import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  buildRenderBuffers,
  compileProcedural,
  createEditorState,
  createOperatorRegistry,
  defaultProcedural,
  sampleCompiled,
  type MeshData,
  type OperatorContext,
} from '../src';
import { cachedCollisionShape, collisionShapeCacheSize } from '../src/physics/shapes';

// Operators and scene tools of the final project runs: scene.measure with many objects, Boolean
// text engravings without zero-area triangles, material.update normal_strength, rigidbody.describe
// after a bake, the WOOD axis, coincident faces in scene.raycast, text_add extents, shared hulls.

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const reports: string[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (l, m) => reports.push(`${l}: ${m}`),
  };
  const run = (id: string, params?: unknown) => {
    const r = reg.run<any>(ctx, id, params);
    if (!r.ok) throw new Error(`${id}: ${r.error}`);
    return r.result;
  };
  const tryRun = (id: string, params?: unknown) => reg.run<any>(ctx, id, params);
  const obj = (name: string) => doc.listObjects().find((o) => o.name === name)!;
  return { doc, ctx, run, tryRun, reports, obj };
}

describe('scene.measure with many objects', () => {
  it('computes surface distances for more than 8 objects', () => {
    const { run, reports } = setup();
    const names: string[] = [];
    for (let i = 0; i < 9; i++) {
      run('mesh.primitive_uv_sphere_add', { name: `Ball.${i}`, radius: 0.4, location: [i, 0, 0] });
      names.push(`Ball.${i}`);
    }
    const r = run('scene.measure', { objects: names, surface_distance: true });
    expect(r.distances.length).toBe(36);
    // every pair has its exact surface distance (none used to have one beyond 8 objects)
    for (const d of r.distances) expect(typeof d.surface_distance).toBe('number');
    const near = r.distances.find((d: any) => d.a_name === 'Ball.0' && d.b_name === 'Ball.1');
    expect(near.surface_distance).toBeCloseTo(0.2, 2);
    expect(r.surface_distances).toEqual({ computed: 36, skipped: 0 });
    expect(reports.filter((m) => m.startsWith('WARNING'))).toEqual([]);
  });

  it('says so when there are too many objects for pairs', () => {
    const { run, reports } = setup();
    const names: string[] = [];
    for (let i = 0; i < 26; i++) {
      run('mesh.primitive_cube_add', { name: `Box.${i}`, size: 0.2, location: [i, 0, 0] });
      names.push(`Box.${i}`);
    }
    const r = run('scene.measure', { objects: names });
    expect(r.distances).toBeUndefined();
    expect(r.distances_skipped).toMatch(/26 objects/);
    expect(reports.some((m) => /WARNING: scene\.measure: 26 objects/.test(m))).toBe(true);
  });
});

describe('Boolean engraving with text', () => {
  it('leaves no zero-area triangles in the render geometry', () => {
    const { doc, run, obj } = setup();
    run('mesh.primitive_cube_add', { name: 'Plate', size: 1 });
    doc.updateObject(obj('Plate').id, { scale: [1.2, 0.3, 0.05] });
    run('object.modifier_add', { type: 'BEVEL', params: { width: 0.005, segments: 2 } });
    run('object.text_add', {
      body: 'CARPE DIEM MMXXVI',
      name: 'Motto',
      size: 0.12,
      align_x: 'CENTER',
      extrude: 0.02,
      location: [0, 0, 0.025],
    });
    run('object.convert', { target: 'MESH' });
    run('object.select', { objects: ['Plate'] });
    run('object.modifier_add', {
      type: 'BOOLEAN',
      params: { object: obj('Motto').id, operation: 'DIFFERENCE' },
    });
    doc.updateObject(obj('Motto').id, { hide_render: true, hide_viewport: true });
    const ev = [...new SceneEvaluator(doc).evaluate(1, { forRender: true }).byId.values()].find(
      (o) => o.name === 'Plate',
    )!;
    const mesh = ev.mesh as MeshData;
    // the Boolean leaves long n-gons with collinear corners along the letters' straight edges
    expect(Math.max(...mesh.faces.map((f) => f.length))).toBeGreaterThan(50);
    const rb = buildRenderBuffers(mesh);
    const P = rb.positions; // float32, as the renderers use them
    const I = rb.indices;
    let zero = 0;
    for (let t = 0; t < I.length; t += 3) {
      const [a, b, c] = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3];
      const e = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
      const f = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      const n = Math.hypot(e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]);
      if (!(n > 1e-12)) zero++;
    }
    // the path tracer skipped 5 such triangles and warned about them in every render
    expect(zero).toBe(0);
  });
});

describe('material.update', () => {
  it('sets normal_strength, sheen_tint and alpha_threshold', () => {
    const { doc, run } = setup();
    run('mesh.primitive_cube_add', { name: 'C' });
    run('material.new', { name: 'Brass' });
    run('material.update', {
      material: 'Brass',
      normal_strength: 0.5,
      sheen_tint: [1, 0.5, 0.2],
      alpha_threshold: 0.3,
    });
    const m = doc.listMaterials().find((x) => x.name === 'Brass')!;
    expect(m.normal_strength).toBe(0.5);
    expect(m.sheen_tint).toEqual([1, 0.5, 0.2]);
    expect(m.alpha_threshold).toBe(0.3);
  });
});

describe('rigidbody.describe after bake_to_keyframes', () => {
  it('lists baked bodies as KEYFRAMED', () => {
    const { doc, run, obj } = setup();
    run('mesh.primitive_cube_add', { name: 'Floor', size: 4 });
    doc.updateObject(obj('Floor').id, { scale: [1, 1, 0.05] });
    run('rigidbody.object_add', { objects: ['Floor'], type: 'PASSIVE' });
    run('mesh.primitive_cube_add', { name: 'Box', size: 0.5, location: [0, 0, 2] });
    run('rigidbody.object_add', { objects: ['Box'], type: 'ACTIVE' });
    run('rigidbody.world_set', { enabled: true, frame_start: 1, frame_end: 20 });
    run('rigidbody.bake_to_keyframes', { objects: ['Box'], frame_start: 1, frame_end: 20 });
    const all = run('rigidbody.describe', { frame: 10 });
    // the baked box used to vanish from the default listing
    expect(all.baked_objects).toBe(1);
    const box = all.objects.find((o: any) => o.name === 'Box');
    expect(box).toMatchObject({ rigid_body: null, motion: 'KEYFRAMED', baked: 'frames 1-20 step 1' });
    expect(box.world_location[2]).toBeLessThan(2);
    // asked for by name: the same, and a passive collider stays STATIC
    const named = run('rigidbody.describe', { frame: 10, objects: ['Box', 'Floor'] });
    expect(named.objects[0].motion).toBe('KEYFRAMED');
    expect(named.objects[1].motion).toBe('STATIC');
    // simulated again: no longer a baked body
    run('rigidbody.object_add', { objects: ['Box'], type: 'ACTIVE' });
    expect(obj('Box').custom_props.rigid_body_baked).toBeUndefined();
    expect(run('rigidbody.describe', { frame: 1 }).baked_objects).toBeUndefined();
  });
});

describe('WOOD procedural texture axis', () => {
  it('turns the growth rings around the chosen axis', () => {
    const wood = (axis: string) =>
      compileProcedural(
        defaultProcedural('WOOD', {
          scale: 1,
          distortion: 0,
          params: { axis, grain: 0, wave_profile: 'SIN' },
        }),
      );
    const px = new Float64Array(4);
    const at = (c: ReturnType<typeof compileProcedural>, x: number, y: number, z: number) => {
      sampleCompiled(c, x, y, z, px);
      return px[0];
    };
    // rings around Z: constant along Z, varying across it
    const z = wood('Z');
    expect(at(z, 0.3, 0.1, 0)).toBeCloseTo(at(z, 0.3, 0.1, 5), 9);
    // rings around X (boards along X): constant along X, the same pattern as Z rotated
    const x = wood('X');
    expect(at(x, 0, 0.3, 0.1)).toBeCloseTo(at(x, 5, 0.3, 0.1), 9);
    expect(at(x, 2, 0.3, 0.1)).toBeCloseTo(at(z, 0.3, 0.1, 2), 9);
    expect(Math.abs(at(x, 0, 0.3, 0) - at(x, 0, 0, 0))).toBeGreaterThan(0.01);
    const y = wood('Y');
    expect(at(y, 0.3, 0, 0.1)).toBeCloseTo(at(y, 0.3, 5, 0.1), 9);
    // documents without the param keep the old orientation
    const old = compileProcedural(defaultProcedural('WOOD', { scale: 1, distortion: 0 }));
    expect(old.mode[2]).toBe(0);
  });
});

describe('scene.raycast all=true', () => {
  it('lists coincident faces of another object', () => {
    const { doc, run, obj } = setup();
    run('mesh.primitive_cube_add', { name: 'Slab', location: [0, 0, -0.1] });
    doc.updateObject(obj('Slab').id, { scale: [1, 1, 0.1] });
    run('mesh.primitive_cube_add', { name: 'Glass', location: [0, 0, 0.3] });
    doc.updateObject(obj('Glass').id, { scale: [0.3, 0.3, 0.3] });
    const r = run('scene.raycast', { origin: [0.05, -0.05, 1], direction: [0, 0, -1], all: true });
    // the glass bottom and the slab top lie at the same height: the slab's face was missing
    expect(r.hits.map((h: any) => `${h.name}@${h.distance.toFixed(3)}`)).toEqual([
      'Glass@0.400',
      'Glass@1.000',
      'Slab@1.000',
      'Slab@1.200',
    ]);
  });
});

describe('object.text_add extents', () => {
  it('returns the layout box and the extent of the letters', () => {
    const { run } = setup();
    const r = run('object.text_add', {
      body: 'VELLUNE',
      name: 'T',
      size: 0.0046,
      space_character: 1.15,
      align_x: 'CENTER',
      extrude: 0.00012,
    });
    expect(r.width).toBeCloseTo(0.021528, 6);
    const measured = run('scene.measure', { objects: ['T'] }).objects[0].bounds.size;
    expect(r.ink_width).toBeCloseTo(measured[0], 6);
    expect(r.ink_height).toBeCloseTo(measured[1], 6);
    expect(r.ink_width).toBeLessThan(r.width);
    const set = run('font.text_set', { object: 'T', body: 'II' });
    expect(set.ink_width).toBeLessThan(set.width);
  });
});

describe('collision shapes', () => {
  it('builds a shape once for equal inputs, shared by operators and simulations', () => {
    let builds = 0;
    const mesh: MeshData = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      faces: [],
    } as unknown as MeshData;
    const build = () => {
      builds++;
      return { error: 'test' };
    };
    const key = `test-${Math.random()}`;
    cachedCollisionShape(key, mesh, build);
    cachedCollisionShape(key, mesh, build);
    expect(builds).toBe(1);
    // rigidbody.object_add builds the shapes for its thickness check; the simulation finds them
    const { doc, run, obj } = setup();
    for (let i = 0; i < 3; i++) {
      run('mesh.primitive_uv_sphere_add', { name: `S${i}`, radius: 0.3 + i * 0.01, location: [i, 0, 2] });
      run('rigidbody.object_add', { objects: [`S${i}`], type: 'ACTIVE' });
    }
    expect(obj('S0').rigid_body).not.toBeNull();
    const before = collisionShapeCacheSize();
    run('rigidbody.world_set', { enabled: true });
    run('rigidbody.describe', { frame: 5 });
    run('rigidbody.describe', { frame: 6 });
    expect(collisionShapeCacheSize()).toBe(before);
    void doc;
  });
});
