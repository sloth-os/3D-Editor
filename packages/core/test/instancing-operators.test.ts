import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  MAX_INSTANCES,
  ROOT_COLLECTION_ID,
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createOperatorRegistry,
  encodeFloat32,
  type Mat4,
  type OperatorContext,
} from '../src';
import { MAX_MAKE_REAL } from '../src/operators/instancing';

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const reports: string[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (_l, m) => reports.push(m),
  };
  const run = (id: string, params?: unknown) => reg.run<any>(ctx, id, params);
  const ok = (id: string, params?: unknown) => {
    const r = run(id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r.result;
  };
  const undo = () =>
    new Y.UndoManager(doc.sharedTypes(), { trackedOrigins: new Set([doc.origin]), captureTimeout: 0 });
  const instances = (owner?: string, forRender = false) =>
    new SceneEvaluator(doc)
      .evaluate(ctx.state.frame, { forRender })
      .instances.filter((i) => !owner || i.ownerId === owner);
  return { doc, reg, ctx, run, ok, undo, reports, instances };
}

function expectMatrixClose(a: Mat4, b: Mat4, digits = 6): void {
  for (let i = 0; i < 16; i++) expect(a[i]).toBeCloseTo(b[i], digits);
}

/** Scene with a 'Trees' collection (two cubes) and a 'Ground' plane. */
function forest() {
  const t = setup();
  const trees = t.ok('collection.create', { name: 'Trees' }).collection as string;
  const a = t.ok('mesh.primitive_cube_add', { name: 'Trunk', size: 0.5, location: [0, 0, 1] })
    .object as string;
  const b = t.ok('mesh.primitive_uv_sphere_add', { name: 'Crown', radius: 0.5, location: [0, 0, 2] })
    .object as string;
  t.ok('object.select', { objects: [a, b] });
  t.ok('object.move_to_collection', { collection: 'Trees' });
  const ground = t.ok('mesh.primitive_plane_add', { name: 'Ground', size: 10, location: [0, 0, 0] })
    .object as string;
  return { ...t, trees, a, b, ground };
}

describe('collection instance operators', () => {
  it('adds an empty instancing a collection (by name) at the cursor', () => {
    const { ok, run, doc, ctx, trees, a, b, instances } = forest();
    ctx.state.cursorLocation = [5, 0, 0];
    const r = ok('object.collection_instance_add', { collection: 'Trees' });
    expect(r).toMatchObject({ collection: trees, collection_name: 'Trees', name: 'Trees' });
    const e = doc.getObject(r.object)!;
    expect(e).toMatchObject({
      type: 'EMPTY',
      instance_type: 'COLLECTION',
      instance_collection: trees,
      location: [5, 0, 0],
    });
    expect(ctx.state.selectedIds).toEqual([e.id]);
    const inst = instances(e.id);
    expect(inst.map((i) => i.sourceId).sort()).toEqual([a, b].sort());
    expect(inst.find((i) => i.sourceId === b)!.matrix.slice(12, 15)).toEqual([5, 0, 2]);
    const placed = ok('object.collection_instance_add', {
      collection: trees,
      name: 'Grove',
      location: [0, 3, 0],
      rotation: [0, 0, Math.PI],
      scale: [2, 2, 2],
    });
    expect(doc.getObject(placed.object)).toMatchObject({
      name: 'Grove',
      location: [0, 3, 0],
      scale: [2, 2, 2],
    });
    expect(run('object.collection_instance_add', { collection: 'Bushes' }).error).toMatch(
      /Collection 'Bushes' not found \(collections: 'Trees'\)/,
    );
    expect(run('object.collection_instance_add', { collection: ROOT_COLLECTION_ID }).error).toMatch(
      /Scene Collection/,
    );
    expect(run('object.collection_instance_add', { collection: 'Scene Collection' }).ok).toBe(false);
  });

  it('sets and clears the instanced collection of an empty, refusing recursion', () => {
    const { ok, run, doc, trees, ground } = forest();
    const empty = ok('object.empty_add', { name: 'Holder' }).object as string;
    expect(ok('object.instance_collection_set', { object: 'Holder', collection: 'Trees' })).toMatchObject({
      collection: trees,
    });
    expect(doc.getObject(empty)).toMatchObject({ instance_type: 'COLLECTION', instance_collection: trees });
    ok('object.instance_collection_set', { object: empty, collection: null });
    expect(doc.getObject(empty)).toMatchObject({ instance_type: 'NONE', instance_collection: null });
    expect(run('object.instance_collection_set', { object: ground, collection: 'Trees' }).error).toMatch(
      /Only empties/,
    );
    // the empty inside the collection it would instance
    doc.updateObject(empty, { collection: trees });
    expect(run('object.instance_collection_set', { object: empty, collection: 'Trees' }).error).toMatch(
      /recurse/,
    );
    // indirect: Trees contains an empty instancing Other, which contains the target empty
    const other = ok('collection.create', { name: 'Other' }).collection as string;
    const target = ok('object.empty_add', { name: 'Target' }).object as string;
    doc.updateObject(target, { collection: other });
    ok('object.instance_collection_set', { object: empty, collection: 'Other' });
    expect(run('object.instance_collection_set', { object: target, collection: 'Trees' }).error).toMatch(
      /recurse/,
    );
  });
});

describe('particle system operators', () => {
  it('adds particle systems with validated settings and reports the result', () => {
    const { ok, run, doc, a, ground } = forest();
    const r = ok('object.particle_system_add', {
      object: 'Ground',
      settings: { count: 120, instance_object: 'Trunk', seed: 3, min_distance: 0.1 },
    });
    expect(r).toMatchObject({
      object: ground,
      name: 'ParticleSystem',
      particles: 120,
      instances: 120,
      errors: [],
    });
    const sys = doc.getObject(ground)!.particle_systems[0];
    expect(sys).toMatchObject({ id: r.particle_system, show_viewport: true, show_render: true });
    // full settings are stored, references as ids
    expect(sys.settings).toMatchObject({ count: 120, instance_object: a, instance_type: 'OBJECT', seed: 3 });
    expect(Object.keys(sys.settings)).toHaveLength(26);
    expect(ok('object.particle_system_add', { object: ground }).name).toBe('ParticleSystem.001');
    // problems of the stored system are reported back
    expect(ok('object.particle_system_add', { object: ground, name: 'Empty' }).errors.join()).toMatch(
      /no instance_object set/,
    );
    // invalid input
    expect(run('object.particle_system_add', { object: ground, settings: { cnt: 3 } }).error).toMatch(/cnt/);
    expect(
      run('object.particle_system_add', { object: ground, settings: { distribution: 'JIT' } }).error,
    ).toMatch(/RANDOM.*JITTERED.*GRID/);
    expect(
      run('object.particle_system_add', { object: ground, settings: { instance_object: 'Nope' } }).error,
    ).toMatch(/instance_object 'Nope' not found/);
    expect(
      run('object.particle_system_add', { object: ground, settings: { instance_object: 'Ground' } }).error,
    ).toMatch(/emitter itself/);
    expect(
      run('object.particle_system_add', { object: ground, settings: { vertex_group_density: 'Top' } }).error,
    ).toMatch(/Vertex group 'Top' not found/);
    expect(run('object.particle_system_add', { object: 'Nope' }).error).toMatch(/Object 'Nope' not found/);
    const cam = ok('object.camera_add', {}).object as string;
    expect(run('object.particle_system_add', { object: cam }).error).toMatch(/need a mesh, curve or text/);
  });

  it('uses collections (by name) with weights given by object names', () => {
    const { ok, doc, a, b, ground } = forest();
    const r = ok('object.particle_system_add', {
      object: ground,
      settings: {
        count: 300,
        instance_collection: 'Trees',
        use_collection_pick_random: true,
        instance_weights: [{ object: 'Crown', weight: 0 }],
      },
    });
    const s = doc.getObject(ground)!.particle_systems[0].settings;
    expect(s).toMatchObject({ instance_type: 'COLLECTION', instance_weights: [{ object: b, weight: 0 }] });
    expect(r.instances).toBe(300);
    const inst = new SceneEvaluator(doc).evaluate(1).instances.filter((i) => i.ownerId === ground);
    expect(new Set(inst.map((i) => i.sourceId))).toEqual(new Set([a]));
    const whole = ok('object.particle_system_update', {
      object: ground,
      settings: { use_whole_collection: true },
    });
    expect(whole).toMatchObject({ particles: 300, instances: 600 });
  });

  it('updates, renames and removes particle systems (undoable)', () => {
    const { ok, run, doc, ground, undo } = forest();
    const um = undo();
    ok('object.particle_system_add', {
      object: ground,
      name: 'Grass',
      settings: { count: 10, instance_object: 'Trunk' },
    });
    const up = ok('object.particle_system_update', {
      object: ground,
      settings: { count: 25, size_random: 0.5 },
    });
    expect(up).toMatchObject({ name: 'Grass', particles: 25, instances: 25 });
    expect(doc.getObject(ground)!.particle_systems[0].settings).toMatchObject({
      count: 25,
      size_random: 0.5,
    });
    ok('object.particle_system_update', {
      object: ground,
      particle_system: 'Grass',
      name: 'Lawn',
      show_render: false,
    });
    expect(doc.getObject(ground)!.particle_systems[0]).toMatchObject({ name: 'Lawn', show_render: false });
    ok('object.particle_system_add', {
      object: ground,
      name: 'Rocks',
      settings: { count: 5, instance_object: 'Crown' },
    });
    expect(run('object.particle_system_update', { object: ground, settings: { count: 1 } }).error).toMatch(
      /has 2 particle systems \('Lawn', 'Rocks'\); pass particle_system/,
    );
    expect(run('object.particle_system_update', { object: ground, particle_system: 'Moss' }).error).toMatch(
      /'Moss' not found on 'Ground' \(systems: 'Lawn', 'Rocks'\)/,
    );
    expect(ok('object.particle_system_remove', { object: ground, particle_system: 'Lawn' })).toMatchObject({
      name: 'Lawn',
      remaining: 1,
    });
    expect(doc.getObject(ground)!.particle_systems.map((p) => p.name)).toEqual(['Rocks']);
    um.undo();
    expect(doc.getObject(ground)!.particle_systems.map((p) => p.name)).toEqual(['Lawn', 'Rocks']);
    um.undo(); // remove 'Rocks' add
    um.undo(); // rename
    um.undo(); // update
    expect(doc.getObject(ground)!.particle_systems[0].settings).toMatchObject({ count: 10, size_random: 0 });
    um.undo();
    expect(doc.getObject(ground)!.particle_systems).toEqual([]);
    um.redo();
    expect(doc.getObject(ground)!.particle_systems[0].name).toBe('Grass');
  });
});

describe('object.scatter_add', () => {
  it('scatters one object and hides it', () => {
    const { ok, doc, a, ground, instances } = forest();
    const r = ok('object.scatter_add', {
      surface: 'Ground',
      objects: ['Trunk'],
      count: 40,
      seed: 2,
      size: 0.5,
    });
    expect(r).toMatchObject({
      object: ground,
      name: 'Scatter',
      instance_type: 'OBJECT',
      instance_object: a,
      particles: 40,
    });
    expect(doc.getObject(a)).toMatchObject({ hide_viewport: true, hide_render: true });
    const inst = instances(ground);
    expect(inst).toHaveLength(40);
    for (const i of inst) {
      expect(i.sourceId).toBe(a);
      expect(Math.hypot(i.matrix[0], i.matrix[1], i.matrix[2])).toBeCloseTo(0.5, 9);
      expect(i.matrix[10]).toBeCloseTo(0.5, 9); // upright on flat ground, random heading only
    }
    expect(new Set(inst.map((i) => i.matrix[0].toFixed(6))).size).toBeGreaterThan(30);
  });

  it('scatters several objects through a new hidden collection', () => {
    const { ok, doc, ground, instances } = forest();
    const rock = ok('mesh.primitive_ico_sphere_add', { name: 'Rock', radius: 0.2 }).object as string;
    const bush = ok('mesh.primitive_cube_add', { name: 'Bush', size: 0.3 }).object as string;
    const r = ok('object.scatter_add', {
      surface: ground,
      objects: ['Rock', 'Bush'],
      count: 200,
      min_distance: 0.2,
      align_to_normal: false,
      size_random: 0.3,
    });
    const coll = doc.getCollection(r.collection)!;
    expect(coll).toMatchObject({ name: 'Scatter Sources', hide_viewport: true, hide_render: true });
    expect(doc.getObject(rock)!.collection).toBe(coll.id);
    expect(doc.getObject(bush)!.collection).toBe(coll.id);
    const settings = doc.getObject(ground)!.particle_systems[0].settings;
    expect(settings).toMatchObject({
      instance_type: 'COLLECTION',
      use_collection_pick_random: true,
      rotation_mode: 'GLOBAL_Z',
      min_distance: 0.2,
    });
    const inst = instances(ground);
    expect(inst).toHaveLength(200);
    expect(new Set(inst.map((i) => i.sourceId))).toEqual(new Set([rock, bush]));
    expect(r).toMatchObject({ particles: 200, instances: 200 });
  });

  it('reuses the source collection when the same objects are scattered again', () => {
    const { ok, doc, ground, instances } = forest();
    ok('mesh.primitive_ico_sphere_add', { name: 'Rock', radius: 0.2 });
    ok('mesh.primitive_cube_add', { name: 'Bush', size: 0.3 });
    const hill = ok('mesh.primitive_uv_sphere_add', { name: 'Hill', radius: 3 }).object as string;
    const first = ok('object.scatter_add', { surface: ground, objects: ['Rock', 'Bush'], count: 20 });
    const second = ok('object.scatter_add', { surface: hill, objects: ['Bush', 'Rock'], count: 30 });
    expect(second.collection).toBe(first.collection);
    expect(doc.listCollections().filter((c) => c.name.startsWith('Scatter Sources'))).toHaveLength(1);
    expect(instances(ground)).toHaveLength(20);
    expect(instances(hill)).toHaveLength(30);
  });

  it('scatters a collection (optionally whole) and validates its input', () => {
    const { ok, run, doc, trees, ground, instances } = forest();
    const r = ok('object.scatter_add', {
      surface: ground,
      collection: 'Trees',
      count: 10,
      whole_collection: true,
    });
    expect(r).toMatchObject({ collection: trees, particles: 10, instances: 20 });
    expect(doc.getCollection(trees)).toMatchObject({ hide_viewport: true, hide_render: true });
    expect(instances(ground)).toHaveLength(20);
    expect(run('object.scatter_add', { surface: ground }).error).toMatch(/either `objects` or `collection`/);
    expect(run('object.scatter_add', { surface: ground, objects: ['Trunk'], collection: 'Trees' }).ok).toBe(
      false,
    );
    expect(run('object.scatter_add', { surface: ground, objects: ['Ground'] }).error).toMatch(
      /cannot scatter itself/,
    );
    // a vertex group restricts the scatter
    const mesh = doc.getObject(ground)!.data!;
    const n = doc.getMesh(mesh)!.positions.length / 3;
    doc.setVertexGroups(mesh, [{ name: 'Left', weights: encodeFloat32(new Array(n).fill(0)) }]);
    const none = ok('object.scatter_add', {
      surface: ground,
      objects: ['Trunk'],
      vertex_group: 'Left',
      name: 'Masked',
    });
    expect(none).toMatchObject({ name: 'Masked', particles: 0 });
    expect(none.errors.join()).toMatch(/zero on every face/);
  });
});

describe('object.duplicates_make_real', () => {
  it('turns collection instances into real objects sharing data', () => {
    const { ok, doc, ctx, trees, a, b, undo } = forest();
    const um = undo();
    const e = ok('object.collection_instance_add', {
      collection: trees,
      location: [10, 0, 0],
      rotation: [0, 0, 1],
    }).object as string;
    const expected = new SceneEvaluator(doc).evaluate(1).instances.filter((i) => i.ownerId === e);
    const r = ok('object.duplicates_make_real', {});
    expect(r.count).toBe(2);
    expect(ctx.state.selectedIds.sort()).toEqual([...r.objects].sort());
    for (const inst of expected) {
      const src = doc.getObject(inst.sourceId)!;
      const made = r.objects.map((id: string) => doc.getObject(id)!).find((o: any) => o.data === src.data)!;
      expect(made.name).toMatch(new RegExp(`^${src.name}\\.\\d{3}$`));
      expect(made).toMatchObject({
        type: 'MESH',
        collection: ROOT_COLLECTION_ID,
        parent: null,
        hide_viewport: false,
      });
      expect(made.material_slots).toEqual(src.material_slots);
      expectMatrixClose(doc.worldMatrix(made.id), inst.matrix);
    }
    expect(doc.getObject(e)!.instance_type).toBe('NONE');
    expect(new SceneEvaluator(doc).evaluate(1).instances).toEqual([]);
    expect([a, b].every((id) => doc.dataUsers(doc.getObject(id)!.data!) === 2)).toBe(true);
    um.undo();
    expect(doc.getObject(e)!.instance_type).toBe('COLLECTION');
    expect(doc.listObjects()).toHaveLength(4);
  });

  it('makes particle instances real, optionally parented to the emitter', () => {
    const { ok, run, doc, ground } = forest();
    ok('object.scatter_add', {
      surface: ground,
      objects: ['Trunk'],
      count: 30,
      size_random: 0.5,
      rotation_random: 0.3,
    });
    doc.updateObject(ground, { location: [1, 2, 3], rotation_euler: [0.1, 0.2, 0.3] });
    const expected = new SceneEvaluator(doc).evaluate(1).instances.filter((i) => i.ownerId === ground);
    const r = ok('object.duplicates_make_real', { objects: ['Ground'], use_base_parent: true });
    expect(r.count).toBe(30);
    const made = r.objects.map((id: string) => doc.getObject(id)!);
    expect(
      made.every((o: any) => o.parent === ground && o.hide_viewport === false && o.hide_render === false),
    ).toBe(true);
    const worlds = made.map((o: any) => doc.worldMatrix(o.id));
    for (const inst of expected)
      expect(worlds.some((w: Mat4) => w.every((x, k) => Math.abs(x - inst.matrix[k]) < 1e-6))).toBe(true);
    // the particle system is kept but hidden, so nothing is doubled
    expect(doc.getObject(ground)!.particle_systems[0]).toMatchObject({
      show_viewport: false,
      show_render: false,
    });
    expect(new SceneEvaluator(doc).evaluate(1).instances).toEqual([]);
    expect(run('object.duplicates_make_real', { objects: ['Ground'] }).error).toMatch(/No instancers/);
  });

  it('refuses to create more than the limit and creates large batches quickly', () => {
    const { ok, run, doc, ground } = forest();
    ok('object.particle_system_add', {
      object: ground,
      settings: { count: MAX_MAKE_REAL + 1, instance_object: 'Trunk', distribution: 'RANDOM' },
    });
    const before = doc.listObjects().length;
    expect(run('object.duplicates_make_real', { objects: [ground] }).error).toMatch(
      /exceeds the limit of 10000/,
    );
    expect(doc.listObjects()).toHaveLength(before);
    ok('object.particle_system_update', { object: ground, settings: { count: 3000 } });
    const t = performance.now();
    expect(ok('object.duplicates_make_real', { objects: [ground] }).count).toBe(3000);
    expect(performance.now() - t).toBeLessThan(8000);
    const names = new Set(doc.listObjects().map((o) => o.name));
    expect(names.size).toBe(before + 3000);
    expect(names.has('Trunk.3000')).toBe(true);
  });
});

describe('object.scatter_add safety', () => {
  /** Rocks above the origin and two ground planes. */
  function rocks() {
    const t = setup();
    const a = t.ok('mesh.primitive_cube_add', { name: 'RockA', size: 0.2, location: [0, 0, 5] }).object as string;
    const b = t.ok('mesh.primitive_cube_add', { name: 'RockB', size: 0.3, location: [0, 0, 5] }).object as string;
    const c = t.ok('mesh.primitive_cube_add', { name: 'RockC', size: 0.4, location: [0, 0, 5] }).object as string;
    const g1 = t.ok('mesh.primitive_plane_add', { name: 'Ground1', size: 10 }).object as string;
    const g2 = t.ok('mesh.primitive_plane_add', { name: 'Ground2', size: 10, location: [20, 0, 0] })
      .object as string;
    const sources = (owner: string) => new Set(t.instances(owner).map((i) => i.sourceId));
    return { ...t, a, b, c, g1, g2, sources };
  }

  it('keeps earlier scatters intact: sources of instanced collections are duplicated, not moved', () => {
    const { ok, doc, a, b, c, g1, g2, sources } = rocks();
    const first = ok('object.scatter_add', { surface: g1, objects: ['RockA', 'RockB'], count: 200 });
    expect(first).toMatchObject({ moved: [a, b], duplicated: [], notes: [] });
    expect(sources(g1)).toEqual(new Set([a, b]));
    const r = ok('object.scatter_add', { surface: g2, objects: ['RockA', 'RockC'], count: 200 });
    // the first scatter still has both rocks
    expect(sources(g1)).toEqual(new Set([a, b]));
    expect(doc.getObject(a)!.collection).toBe(first.collection);
    expect(r.moved).toEqual([c]);
    expect(r.duplicated).toHaveLength(1);
    const dup = r.duplicated[0];
    expect(dup.object).toBe(a);
    expect(doc.getObject(dup.duplicate)).toMatchObject({
      data: doc.getObject(a)!.data,
      collection: r.collection,
      hide_viewport: true,
      hide_render: true,
    });
    expect(sources(g2)).toEqual(new Set([dup.duplicate, c]));
    expect(r.notes.join('\n')).toMatch(/'RockA' stays in collection 'Scatter Sources' \(instanced by particle system/);
    expect(doc.getCollection(r.collection)!.name).toBe('Scatter Sources.001');
  });

  it('keeps collection instances intact and leaves their objects visible', () => {
    const t = setup();
    t.ok('collection.create', { name: 'House' });
    const walls = t.ok('mesh.primitive_cube_add', { name: 'Walls', size: 2 }).object as string;
    const door = t.ok('mesh.primitive_cube_add', { name: 'Door', size: 0.5 }).object as string;
    t.ok('object.select', { objects: [walls, door] });
    t.ok('object.move_to_collection', { collection: 'House' });
    const e = t.ok('object.collection_instance_add', { collection: 'House', location: [10, 0, 0] }).object;
    t.ok('mesh.primitive_ico_sphere_add', { name: 'Rock', radius: 0.2 });
    const ground = t.ok('mesh.primitive_plane_add', { name: 'Ground', size: 10 }).object as string;
    expect(t.instances(e)).toHaveLength(2);
    const r = t.ok('object.scatter_add', { surface: ground, objects: ['Rock', 'Door'], count: 20 });
    expect(t.instances(e)).toHaveLength(2);
    expect(t.doc.getObject(door)).toMatchObject({ hide_viewport: false, hide_render: false });
    expect(t.doc.getCollection(t.doc.getObject(door)!.collection)!.name).toBe('House');
    expect(r.duplicated.map((d: any) => d.object)).toEqual([door]);
    expect(r.notes.join()).toMatch(/'Door' stays in collection 'House' \(instanced by 'House' \(collection instance\)\)/);
    // a single source in an instanced collection is instanced directly and left visible
    const one = t.ok('object.scatter_add', { surface: ground, objects: ['Walls'], count: 5, name: 'Solo' });
    expect(one).toMatchObject({ instance_object: walls, hidden: [] });
    expect(one.notes.join()).toMatch(/'Walls' was left visible: its collection 'House' is instanced by/);
    expect(t.doc.getObject(walls)!.hide_viewport).toBe(false);
  });

  it('validates everything before changing the scene', () => {
    const { run, ok, doc, a, b, g1 } = rocks();
    const sun = ok('object.light_add', { type: 'SUN', name: 'Sun' }).object as string;
    const cam = ok('object.camera_add', { name: 'Cam' }).object as string;
    const collections = () => doc.listCollections().map((c) => c.name);
    const untouched = () => {
      expect(collections()).toEqual(['Scene Collection']);
      for (const id of [a, b, sun, cam])
        expect(doc.getObject(id)).toMatchObject({
          collection: ROOT_COLLECTION_ID,
          hide_viewport: false,
          hide_render: false,
        });
      expect(doc.getObject(g1)!.particle_systems).toEqual([]);
    };
    // sources without geometry
    expect(run('object.scatter_add', { surface: g1, objects: ['RockA', 'Sun', 'Cam'] }).error).toMatch(
      /Cannot scatter 'Sun' \(LIGHT\), 'Cam' \(CAMERA\): only mesh, curve and text objects/,
    );
    expect(run('object.scatter_add', { surface: g1, objects: ['Sun'] }).error).toMatch(/'Sun' \(LIGHT\)/);
    untouched();
    // invalid settings (a missing vertex group) for one and for several objects
    for (const objects of [['RockA'], ['RockA', 'RockB']]) {
      const r = run('object.scatter_add', { surface: g1, objects, vertex_group: 'Missing' });
      expect(r.error).toMatch(/Vertex group 'Missing' not found on 'Ground1'/);
      untouched();
    }
    // a source that instances the surface itself
    ok('collection.create', { name: 'Ground Set' });
    ok('object.select', { objects: [g1] });
    ok('object.move_to_collection', { collection: 'Ground Set' });
    const holder = ok('object.collection_instance_add', { collection: 'Ground Set', name: 'Holder' }).object;
    expect(run('object.scatter_add', { surface: g1, objects: ['Holder', 'RockA'] }).error).toMatch(
      /'Holder' instances 'Ground1'.*would recurse/,
    );
    expect(doc.getObject(a)!.collection).toBe(ROOT_COLLECTION_ID);
    expect(doc.getObject(holder)!.hide_viewport).toBe(false);
  });

  it('documents placement by the origin, the size factors and count = particles', () => {
    const { reg, ok, doc } = setup();
    const info = reg.describe().find((o) => o.id === 'object.scatter_add')! as any;
    expect(info.description).toMatch(/ORIGIN is put on the surface/);
    expect(info.description).toMatch(/scale of the surface object along its normal/);
    expect(info.parameters.properties.count.description).toMatch(/Number of particles.*instances = count × objects/);
    expect(info.parameters.properties.size.description).toMatch(/surface scaled ×10, size 0.1 gives the original size/);
    // the documented size rule
    ok('mesh.primitive_cube_add', { name: 'Rock', size: 1, location: [0, 0, 5] });
    const ground = ok('mesh.primitive_plane_add', { name: 'Ground', size: 2 }).object as string;
    doc.updateObject(ground, { scale: [10, 10, 10] });
    ok('object.scatter_add', { surface: ground, objects: ['Rock'], count: 5, size: 0.1 });
    const m = new SceneEvaluator(doc).evaluate(1).instances[0].matrix;
    expect(Math.hypot(m[0], m[1], m[2])).toBeCloseTo(1, 9);
    // the documented origin rule: a centred cube sinks halfway into the ground
    expect(m[14]).toBeCloseTo(0, 9);
  });
});

describe('particle operator reports and edits', () => {
  it('report render-only systems and emitter problems such as the scene-wide limit', () => {
    const { ok, doc, instances } = setup();
    ok('mesh.primitive_cube_add', { name: 'Rock', size: 0.1, location: [0, 0, 50] });
    const field = ok('mesh.primitive_plane_add', { name: 'A_Field', size: 100 }).object as string;
    const hidden = ok('object.particle_system_add', {
      object: field,
      settings: { count: 50, instance_object: 'Rock' },
      show_viewport: false,
    });
    expect(hidden).toMatchObject({ particles: 50, instances: 50, errors: [] });
    ok('object.particle_system_update', {
      object: field,
      settings: { count: MAX_INSTANCES, distribution: 'RANDOM' },
      show_viewport: true,
    });
    ok('mesh.primitive_plane_add', { name: 'B_Patio', size: 4, location: [0, 200, 0] });
    const r = ok('object.particle_system_add', {
      object: 'B_Patio',
      settings: { instance_object: 'Rock', count: 50 },
    });
    expect(r.particles).toBe(50);
    expect(r.errors.join('\n')).toMatch(
      /exceeds the limit of 200000 instances: all 50 instances of 'B_Patio' are skipped/,
    );
    expect(instances(doc.findObjectByName('B_Patio')!.id)).toHaveLength(0);
  });

  it('refuses instance objects and collections that would make the emitter instance itself', () => {
    const { ok, run, doc } = setup();
    ok('collection.create', { name: 'C' });
    const ground = ok('mesh.primitive_plane_add', { name: 'Ground', size: 10 }).object as string;
    ok('object.select', { objects: [ground] });
    ok('object.move_to_collection', { collection: 'C' });
    ok('object.collection_instance_add', { collection: 'C', name: 'E', location: [20, 0, 0] });
    expect(
      run('object.particle_system_add', { object: ground, settings: { instance_object: 'E', count: 5 } }).error,
    ).toMatch(/instance_object 'E' instances 'Ground' itself .*would recurse/);
    // the emitter as a direct member of its own instance collection is fine (it is skipped)
    ok('mesh.primitive_cube_add', { name: 'Pebble', size: 0.1 });
    ok('object.select', { objects: ['Pebble'] });
    ok('object.move_to_collection', { collection: 'C' });
    const own = ok('object.particle_system_add', {
      object: ground,
      settings: { instance_collection: 'C', count: 5 },
    });
    expect(own).toMatchObject({ particles: 5, errors: [] });
    // the operators also report cycles found in stored data
    const sys = doc.getObject(ground)!.particle_systems[0];
    doc.updateObject(ground, {
      particle_systems: [{ ...sys, settings: { ...sys.settings, instance_type: 'OBJECT', instance_object: 'E' } }],
    });
    const r = ok('object.particle_system_update', { object: ground, settings: { count: 6 } });
    expect(r.errors.join('\n')).toMatch(/Instancing cycle: 'Ground' ends up instancing itself/);
  });

  it('keeps F-curves and drivers on renamed systems and removes them with the system', () => {
    const { ok, doc } = setup();
    ok('mesh.primitive_cube_add', { name: 'Rock', size: 0.2 });
    const ground = ok('mesh.primitive_plane_add', { name: 'Ground', size: 10 }).object as string;
    ok('object.particle_system_add', { object: ground, name: 'Grass', settings: { count: 10, instance_object: 'Rock' } });
    doc.setFCurve({
      target_type: 'object',
      target_id: ground,
      path: 'particle_systems["Grass"].count',
      index: 0,
      keyframes: [
        { frame: 1, value: 10, interpolation: 'LINEAR' },
        { frame: 11, value: 110, interpolation: 'LINEAR' },
      ],
      extrapolation: 'CONSTANT',
      mute: false,
    } as any);
    doc.setDriver({
      target_type: 'object',
      target_id: ground,
      path: 'particle_systems["Grass"].seed',
      index: 0,
      expression: 'n',
      variables: [{ name: 'n', target_type: 'object', target_id: ground, path: 'particle_systems["Grass"].count', index: 0 }],
      mute: false,
    });
    const at11 = () =>
      new SceneEvaluator(doc).evaluate(11).instances.filter((i) => i.ownerId === ground).length;
    expect(at11()).toBe(110);
    ok('object.particle_system_update', { object: ground, particle_system: 'Grass', name: 'Lawn' });
    expect(at11()).toBe(110);
    expect(doc.listFCurves(ground).map((f) => f.path)).toEqual(['particle_systems["Lawn"].count']);
    expect(doc.listDrivers()).toMatchObject([
      { path: 'particle_systems["Lawn"].seed', variables: [{ path: 'particle_systems["Lawn"].count' }] },
    ]);
    ok('object.particle_system_remove', { object: ground, particle_system: 'Lawn' });
    expect(doc.listFCurves(ground)).toEqual([]);
    expect(doc.listDrivers()).toEqual([]);
  });

  it('accepts unrelated updates after the density vertex group was removed', () => {
    const { ok, doc, instances } = setup();
    ok('mesh.primitive_cube_add', { name: 'Rock', size: 0.2 });
    const ground = ok('mesh.primitive_plane_add', { name: 'Ground', size: 10 }).object as string;
    const meshId = doc.getObject(ground)!.data!;
    const nv = doc.getMesh(meshId)!.positions.length / 3;
    doc.setVertexGroups(meshId, [{ name: 'Density', weights: encodeFloat32(new Array(nv).fill(1)) }]);
    ok('object.particle_system_add', {
      object: ground,
      settings: { count: 50, instance_object: 'Rock', vertex_group_density: 'Density' },
    });
    doc.setVertexGroups(meshId, []);
    expect(instances(ground)).toHaveLength(50);
    const r = ok('object.particle_system_update', { object: ground, settings: { count: 80 } });
    expect(r).toMatchObject({ particles: 80 });
    expect(r.errors.join()).toMatch(/vertex group 'Density' not found; density ignored/);
  });

  it('makes render-only particle systems real', () => {
    const { ok, instances } = setup();
    ok('mesh.primitive_cube_add', { name: 'Rock', size: 0.2, location: [0, 0, 5] });
    const ground = ok('mesh.primitive_plane_add', { name: 'Ground', size: 10 }).object as string;
    ok('object.particle_system_add', {
      object: ground,
      settings: { count: 50, instance_object: 'Rock' },
      show_viewport: false,
      show_render: true,
    });
    expect(instances(ground, true)).toHaveLength(50);
    const r = ok('object.duplicates_make_real', { objects: [ground] });
    expect(r.count).toBe(50);
    expect(instances(ground, true)).toHaveLength(0);
  });
});

describe('operator descriptions', () => {
  it('exposes the instancing operators with documented parameters', () => {
    const { reg } = setup();
    const ids = [
      'object.collection_instance_add',
      'object.instance_collection_set',
      'object.particle_system_add',
      'object.particle_system_update',
      'object.particle_system_remove',
      'object.duplicates_make_real',
      'object.scatter_add',
    ];
    const info = reg.describe().filter((o) => ids.includes(o.id));
    expect(info.map((o) => o.id).sort()).toEqual([...ids].sort());
    const add = info.find((o) => o.id === 'object.particle_system_add')! as any;
    const settings = add.parameters.properties.settings;
    expect(settings.additionalProperties).toBe(false);
    expect(Object.keys(settings.properties)).toContain('min_distance');
    for (const [name, field] of Object.entries<any>(settings.properties))
      expect(field.description, `settings.${name} needs a description`).toBeTruthy();
    for (const o of info)
      for (const [name, field] of Object.entries<any>((o.parameters as any).properties ?? {}))
        expect(field.description, `${o.id}.${name} needs a description`).toBeTruthy();
  });
});
