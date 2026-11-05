import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  OperatorRegistry,
  SceneDoc,
  createEditorState,
  createOperatorRegistry,
  defineOperator,
  findUnknownParams,
  schemaParamNames,
  suggestNames,
  type OperatorContext,
} from '../src';

// Regression tests for phase-3 issues #0, #14 and #24: unknown (misspelled or unsupported)
// operator parameters used to be dropped silently, so the operator ran with defaults.

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const reports: { level: string; message: string }[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'mcp',
    report: (level, message) => reports.push({ level, message }),
  };
  const run = (id: string, params?: unknown) => reg.run(ctx, id, params);
  return { doc, reg, ctx, run, reports };
}

describe('unknown operator parameters', () => {
  it('rejects a misspelled parameter instead of using the default (mesh.primitive_cylinder_add raduis)', () => {
    const { doc, run } = setup();
    const r = run('mesh.primitive_cylinder_add', { name: 'TypoCyl', raduis: 3, depth: 1 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_PARAMS');
    expect(r.error).toContain("unknown parameter 'raduis' (did you mean 'radius'?)");
    expect(r.error).toContain('Valid parameters: vertices, radius, depth, end_fill_type');
    // nothing was created
    expect(doc.findObjectByName('TypoCyl')).toBeNull();
  });

  it('lists every unknown key with its suggestion (robot-workcell repro)', () => {
    const { run } = setup();
    const r = run('mesh.primitive_cylinder_add', { name: 'TypoCyl', radius: 0.5, dept: 0.2, vertex: 8 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(
      "unknown parameters 'dept' (did you mean 'depth'?), 'vertex' (did you mean 'vertices'?)",
    );
  });

  it('rejects unknown keys of operators without parameters of that name (object.empty_add bogus)', () => {
    const { doc, run } = setup();
    const r = run('object.empty_add', { name: 'B2', bogus: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown parameter 'bogus'\. Valid parameters: type, radius, location/);
    expect(doc.findObjectByName('B2')).toBeNull();
  });

  it('explains that selection-based operators take the selection, not objects (domino-cascade repro)', () => {
    const { doc, run } = setup();
    run('mesh.primitive_cube_add', { name: 'A', scale: [2, 1, 1] });
    run('mesh.primitive_cube_add', { name: 'B', scale: [3, 1, 1] });
    const r = run('object.transform_apply', {
      objects: ['A'],
      location: false,
      rotation: false,
      scale: true,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("unknown parameter 'objects'");
    expect(r.error).toContain('object.select {objects: [...]}');
    // nothing was applied to the selected object B
    expect(doc.findObjectByName('B')!.scale).toEqual([3, 1, 1]);
    expect(doc.findObjectByName('A')!.scale).toEqual([2, 1, 1]);
  });

  it('suggests the generator parameter for a typo (object.generate_table widht)', () => {
    const { run } = setup();
    const r = run('object.generate_table', { widht: 3 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("'widht' (did you mean 'width'?)");
  });

  it('suggests a parameter with another name for the same thing (material slot: index vs slot)', () => {
    const { run } = setup();
    run('mesh.primitive_cube_add');
    run('object.mode_set', { mode: 'EDIT' });
    const r = run('object.material_slot_assign', { slot: 2 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("unknown parameter 'slot' (did you mean 'index'?). Valid parameters: index");
  });

  it('tells agents to set the frame for operators without a frame parameter', () => {
    const { run } = setup();
    const r = run('object.select_all', { action: 'SELECT', frame: 50 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('scene.frame_set {frame}');
  });

  it('checks keys of nested parameter objects (curve points, procedural settings)', () => {
    const { doc, run } = setup();
    const r = run('curve.add_from_points', {
      name: 'C',
      points: [[0, 0, 0], { co: [1, 0, 0], tilte: 1 }, { co: [2, 0, 0], tilte: 1 }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(
      "unknown key 'tilte' (did you mean 'tilt'?) in points[i] (2 entries, e.g. points[1])",
    );
    expect(r.error).toContain('Valid keys there: co, handle_left, handle_right');
    expect(doc.findObjectByName('C')).toBeNull();
    // valid nested keys still work
    expect(
      run('curve.add_from_points', { name: 'C', points: [[0, 0, 0], { co: [1, 0, 0], tilt: 1 }] }).ok,
    ).toBe(true);
  });

  it('reports unknown keys together with invalid values', () => {
    const { run } = setup();
    const r = run('mesh.primitive_cube_add', { size: -1, sise: 3 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("'sise' (did you mean 'size'?)");
    expect(r.error).toMatch(/size: Too small/);
  });

  it('treats keys whose value is undefined as not given (JavaScript callers)', () => {
    const { run } = setup();
    expect(run('mesh.primitive_cube_add', { size: 2, location: undefined, bogus: undefined }).ok).toBe(true);
  });

  it('keeps accepting every documented parameter, defaults and records', () => {
    const { run, doc } = setup();
    expect(run('mesh.primitive_cylinder_add', { vertices: 8, radius: 0.5, depth: 0.2 }).ok).toBe(true);
    const cyl = doc.listObjects()[0];
    expect(doc.getMesh(cyl.data!)!.positions.length / 3).toBe(16);
    // records (any key) are not restricted
    expect(run('data.set_property', { kind: 'render', values: { resolution_x: 640 } }).ok).toBe(true);
    // a redo with the parsed parameters (defaults filled in) is accepted
    const first = run('mesh.primitive_torus_add', { major_segments: 12 });
    expect(first.ok).toBe(true);
    expect(run('mesh.primitive_torus_add', first.params).ok).toBe(true);
  });

  it('accepts the parsed parameters of every operator again (redo panel round trip)', () => {
    const { reg } = setup();
    for (const def of reg.list()) {
      const parsed = def.schema.safeParse({});
      if (!parsed.success) continue;
      expect(findUnknownParams(def.schema, parsed.data), def.id).toEqual([]);
    }
  });

  it('closes the JSON schemas of operator parameters (additionalProperties: false)', () => {
    const { reg } = setup();
    const info = reg.describe().find((o) => o.id === 'mesh.primitive_cylinder_add')!;
    expect((info.parameters as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    const curve = reg.describe().find((o) => o.id === 'curve.add_from_points')!;
    expect(JSON.stringify(curve.parameters)).toContain('"additionalProperties":false');
    // records keep accepting any key
    const set = reg.describe().find((o) => o.id === 'data.set_property')!;
    const values = (set.parameters as { properties: Record<string, { additionalProperties?: unknown }> })
      .properties.values;
    expect(values.additionalProperties).not.toBe(false);
  });

  it('describes the parameter names of a schema', () => {
    expect(schemaParamNames(z.object({ a: z.number(), b: z.string().optional() }))).toEqual(['a', 'b']);
    expect(schemaParamNames(z.object({ a: z.number() }).passthrough())).toBeNull();
    expect(schemaParamNames(z.preprocess((v) => v, z.object({ a: z.number() })))).toBeNull();
    const reg = new OperatorRegistry();
    reg.register(
      defineOperator({
        id: 'test.any',
        label: 'Any',
        description: '',
        category: 'Test',
        schema: z.object({ a: z.number().default(1) }).passthrough(),
        execute: (_ctx, p) => p,
      }),
    );
    const doc = SceneDoc.create({ empty: true });
    const ctx: OperatorContext = {
      doc,
      state: createEditorState(),
      origin: doc.origin,
      source: 'test',
      report: () => {},
    };
    // operators that declare passthrough schemas still accept anything
    expect(reg.run(ctx, 'test.any', { a: 2, b: 3 }).ok).toBe(true);
    expect(reg.paramNames('test.any')).toBeNull();
  });

  it('ranks suggestions: typos, synonyms, substrings', () => {
    expect(suggestNames('raduis', ['radius', 'depth'])).toEqual(['radius']);
    expect(suggestNames('segments', ['major_segments', 'minor_segments', 'major_radius'])).toEqual([
      'major_segments',
      'minor_segments',
    ]);
    expect(suggestNames('endFillType', ['end_fill_type', 'vertices'])).toEqual(['end_fill_type']);
    expect(suggestNames('slot', ['index'])).toEqual(['index']);
    expect(suggestNames('bogus', ['type', 'radius'])).toEqual([]);
  });
});
