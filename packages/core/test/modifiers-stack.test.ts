import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  createCube,
  createGrid,
  defaultModifierName,
  defaultModifierParams,
  describeModifierTypes,
  getModifierDef,
  identity4,
  listModifierDefs,
  meshStats,
  registerBuiltinModifiers,
  translation4,
  vertexCount,
  type MeshData,
  type ModifierData,
} from '../src';
import { makeCtx, modifierData, signedVolume } from './modifiers-helpers';

const REQUIRED = [
  'SUBSURF',
  'MIRROR',
  'ARRAY',
  'SOLIDIFY',
  'BOOLEAN',
  'TRIANGULATE',
  'WELD',
  'SMOOTH',
  'DISPLACE',
  'CAST',
  'SIMPLE_DEFORM',
  'WAVE',
  'SMOOTH_BY_ANGLE',
  'DECIMATE',
  'WIREFRAME',
  'SCREW',
  'EDGE_SPLIT',
  'BUILD',
  'SHRINKWRAP',
  'BEVEL',
];

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as object)) deepFreeze(x);
  }
  return v;
}

describe('modifier registry', () => {
  it('registers every built-in type with Blender defaults and documentation', () => {
    registerBuiltinModifiers();
    registerBuiltinModifiers(); // idempotent
    const types = listModifierDefs().map((d) => d.type);
    for (const t of REQUIRED) expect(types).toContain(t);
    expect(new Set(types).size).toBe(types.length);
    for (const d of listModifierDefs()) {
      expect(d.label.length).toBeGreaterThan(2);
      expect(d.description.length).toBeGreaterThan(60);
      expect(['GENERATE', 'DEFORM', 'NORMALS', 'EDIT']).toContain(d.category);
      expect(() => d.schema.parse({})).not.toThrow();
    }
    expect(defaultModifierParams('SUBSURF')).toMatchObject({
      levels: 1,
      render_levels: 2,
      subdivision_type: 'CATMULL_CLARK',
      use_creases: true,
    });
    expect(defaultModifierParams('MIRROR')).toMatchObject({
      use_axis: [true, false, false],
      use_mirror_merge: true,
      merge_threshold: 0.001,
    });
    expect(defaultModifierParams('ARRAY')).toMatchObject({
      count: 2,
      use_relative_offset: true,
      relative_offset_displace: [1, 0, 0],
    });
    expect(defaultModifierParams('SOLIDIFY')).toMatchObject({ thickness: 0.01, offset: -1, use_rim: true });
    expect(defaultModifierParams('DISPLACE')).toMatchObject({
      strength: 1,
      mid_level: 0.5,
      texture_type: 'CLOUDS',
      noise_scale: 0.25,
      noise_depth: 2,
    });
    expect(defaultModifierParams('WAVE')).toMatchObject({
      height: 0.5,
      width: 1.5,
      narrowness: 1.5,
      speed: 0.25,
    });
    expect(defaultModifierParams('SCREW')).toMatchObject({
      angle: 2 * Math.PI,
      steps: 16,
      render_steps: 16,
      axis: 'Z',
    });
    expect(defaultModifierParams('BUILD')).toMatchObject({ frame_start: 1, frame_duration: 100 });
    expect(defaultModifierParams('BEVEL')).toMatchObject({ width: 0.1, segments: 1, affect: 'EDGES' });
    expect(defaultModifierParams('SIMPLE_DEFORM').angle).toBeCloseTo(Math.PI / 4);
    expect(defaultModifierParams('DECIMATE').angle_limit).toBeCloseTo((5 * Math.PI) / 180);
    // defaults are fresh objects (no shared mutable arrays)
    expect(defaultModifierParams('ARRAY').relative_offset_displace).not.toBe(
      defaultModifierParams('ARRAY').relative_offset_displace,
    );
    expect(defaultModifierName('SUBSURF')).toBe('Subdivision');
    expect(defaultModifierName('MIRROR')).toBe('Mirror');
  });

  it('describes types with JSON schemas for UIs and agents', () => {
    const info = describeModifierTypes();
    const subsurf = info.find((i) => i.type === 'SUBSURF')!;
    expect(subsurf.label).toBe('Subdivision Surface');
    expect((subsurf.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty(
      'levels',
    );
    expect(info.find((i) => i.type === 'WAVE')!.timeDependent).toBe(true);
  });

  it('never mutates the input mesh', () => {
    registerBuiltinModifiers();
    const make = (): MeshData => {
      const m = createCube();
      m.colors = new Array(32).fill(0.5);
      m.edgeAttrs = { '0,1': { crease: 0.5, sharp: true } };
      m.looseEdges = [];
      return m;
    };
    const operand = deepFreeze(createCube({ size: 1 }));
    const ctx = makeCtx({
      frame: 50,
      getObjectMesh: () => ({ mesh: operand, matrix: translation4([0.5, 0.5, 0.5]) }),
    });
    const variants: Record<string, Record<string, unknown>[]> = {
      BOOLEAN: [{ object: 'x' }, { object: 'x', operation: 'UNION' }],
      SHRINKWRAP: [{ target: 'x' }, { target: 'x', wrap_method: 'PROJECT' }],
      DECIMATE: [{ ratio: 0.5 }, { decimate_type: 'DISSOLVE' }],
      MIRROR: [{ use_bisect_axis: [true, true, false] }],
      ARRAY: [{ use_merge_vertices: true, count: 3 }],
      SUBSURF: [{ levels: 2 }],
      BEVEL: [{ segments: 2 }, { affect: 'VERTICES' }],
      SCREW: [{ angle: 1 }],
    };
    for (const def of listModifierDefs()) {
      for (const params of [{}, ...(variants[def.type] ?? [])]) {
        const input = deepFreeze(make());
        const before = JSON.stringify(input);
        expect(
          () => def.apply(input, def.schema.parse(params), ctx),
          `${def.type} ${JSON.stringify(params)}`,
        ).not.toThrow();
        expect(JSON.stringify(input)).toBe(before);
      }
    }
  });
});

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const meshId = doc.addMesh('Cube', createCube());
  const id = doc.addObject({ type: 'MESH', name: 'Cube', data: meshId });
  return { doc, meshId, id, ev: new SceneEvaluator(doc) };
}

function setModifiers(doc: SceneDoc, id: string, mods: ModifierData[]) {
  doc.updateObject(id, { modifiers: mods });
}

describe('modifier stack evaluation', () => {
  it('evaluates stored stacks with viewport/render levels and visibility flags', () => {
    const { doc, id, ev } = setup();
    const sub = modifierData('SUBSURF', {});
    setModifiers(doc, id, [sub]);
    expect(meshStats(ev.evaluate(1).byId.get(id)!.mesh!).faces).toBe(24);
    expect(meshStats(ev.evaluate(1, { forRender: true }).byId.get(id)!.mesh!).faces).toBe(96);
    expect(ev.evaluate(1).byId.get(id)!.baseMesh!.faces.length).toBe(6);
    setModifiers(doc, id, [{ ...sub, show_viewport: false }]);
    expect(ev.evaluate(1).byId.get(id)!.mesh!.faces.length).toBe(6);
    expect(ev.evaluate(1, { forRender: true }).byId.get(id)!.mesh!.faces.length).toBe(96);
    setModifiers(doc, id, [{ ...sub, show_render: false }]);
    expect(ev.evaluate(1, { forRender: true }).byId.get(id)!.mesh!.faces.length).toBe(6);
    setModifiers(doc, id, [{ ...sub, show_in_editmode: false }]);
    expect(ev.evaluate(1, { editObjectId: id }).byId.get(id)!.mesh!.faces.length).toBe(6);
    expect(ev.evaluate(1).byId.get(id)!.mesh!.faces.length).toBe(24);
  });

  it('applies modifiers in stack order', () => {
    const { doc, id, ev } = setup();
    setModifiers(doc, id, [modifierData('SUBSURF', { levels: 1 }), modifierData('TRIANGULATE')]);
    expect(ev.evaluate(1).byId.get(id)!.mesh!.faces.length).toBe(48);
    setModifiers(doc, id, [modifierData('TRIANGULATE'), modifierData('SUBSURF', { levels: 1 })]);
    expect(ev.evaluate(1).byId.get(id)!.mesh!.faces.length).toBe(36);
  });

  it('reads Boolean operands through the dependency graph', () => {
    const { doc, id, ev } = setup();
    const cutterMesh = doc.addMesh('Cutter', createCube());
    const cutter = doc.addObject({ type: 'MESH', name: 'Cutter', data: cutterMesh, location: [1, 0.7, 0.4] });
    doc.updateObject(id, { location: [0, 0, 0] });
    setModifiers(doc, id, [modifierData('BOOLEAN', { object: cutter })]);
    const v1 = signedVolume(ev.evaluate(1).byId.get(id)!.mesh!);
    expect(v1).toBeCloseTo(8 - 2.08, 4);
    // moving the operand re-evaluates the owner
    doc.updateObject(cutter, { location: [1.5, 0.7, 0.4] });
    expect(signedVolume(ev.evaluate(1).byId.get(id)!.mesh!)).toBeCloseTo(8 - 0.5 * 1.3 * 1.6, 4);
    // ... and so does editing the operand mesh or modifier stack
    setModifiers(doc, cutter, [modifierData('ARRAY', { count: 1 })]);
    doc.setMesh(cutterMesh, createCube({ size: 1 }));
    doc.updateObject(cutter, { location: [1, 0.7, 0.4] });
    // overlap of the unit cutter: x ∈ [0.5, 1], y ∈ [0.2, 1], z ∈ [-0.1, 0.9]
    const v3 = signedVolume(ev.evaluate(1).byId.get(id)!.mesh!);
    expect(v3).toBeCloseTo(8 - 0.5 * 0.8 * 1, 4);
    // the operand itself is unaffected
    expect(ev.evaluate(1).byId.get(cutter)!.mesh!.faces.length).toBe(6);
  });

  it('re-evaluates time dependent modifiers per frame', () => {
    const doc = SceneDoc.create({ empty: true });
    const id = doc.addObject({
      type: 'MESH',
      name: 'Grid',
      data: doc.addMesh('Grid', createGrid({ x_subdivisions: 8, y_subdivisions: 8 })),
    });
    const ev = new SceneEvaluator(doc);
    setModifiers(doc, id, [modifierData('WAVE')]);
    const a = ev.evaluate(1).byId.get(id)!;
    const b = ev.evaluate(10).byId.get(id)!;
    expect(a.mesh!.positions).not.toEqual(b.mesh!.positions);
    expect(a.meshKey).not.toBe(b.meshKey);
    expect(ev.evaluate(10).byId.get(id)!.mesh).toBe(b.mesh);
    setModifiers(doc, id, [modifierData('BUILD', { frame_start: 1, frame_duration: 10 })]);
    expect(ev.evaluate(1).byId.get(id)!.mesh!.faces.length).toBe(0);
    expect(ev.evaluate(6).byId.get(id)!.mesh!.faces.length).toBe(32);
    expect(ev.evaluate(20).byId.get(id)!.mesh!.faces.length).toBe(64);
  });

  it('reports broken modifiers instead of throwing and keeps evaluating the rest', () => {
    const { doc, id, ev } = setup();
    const broken = modifierData('SUBSURF', { levels: 99 });
    const unknown = modifierData('NOT_A_MODIFIER');
    setModifiers(doc, id, [broken, unknown, modifierData('TRIANGULATE')]);
    const r = ev.evaluate(1).byId.get(id)!;
    expect(r.modifierErrors.map((e) => e.modifierId)).toEqual([broken.id, unknown.id]);
    expect(r.modifierErrors[0].message).toMatch(/levels/);
    expect(r.modifierErrors[1].message).toMatch(/Unknown modifier type/);
    expect(r.mesh!.faces.length).toBe(12);
  });

  it('mirrors across another object and evaluates linked duplicates independently', () => {
    const { doc, id, meshId, ev } = setup();
    const helper = doc.addObject({
      type: 'MESH',
      name: 'Helper',
      data: doc.addMesh('H', createCube({ size: 0.1 })),
      location: [2, 0, 0],
    });
    setModifiers(doc, id, [modifierData('MIRROR', { mirror_object: helper })]);
    const twin = doc.addObject({ type: 'MESH', name: 'Twin', data: meshId });
    setModifiers(doc, twin, [modifierData('ARRAY', { count: 3 })]);
    const scene = ev.evaluate(1);
    expect(vertexCount(scene.byId.get(id)!.mesh!)).toBe(16);
    expect(Math.max(...scene.byId.get(id)!.mesh!.positions.filter((_, i) => i % 3 === 0))).toBeCloseTo(5);
    expect(vertexCount(scene.byId.get(twin)!.mesh!)).toBe(24);
    expect(
      getModifierDef('MIRROR')!.apply(
        createCube(),
        getModifierDef('MIRROR')!.schema.parse({}),
        makeCtx({ objectMatrix: identity4() }),
      ).faces.length,
    ).toBe(12);
  });
});
