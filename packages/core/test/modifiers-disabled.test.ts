import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createMesh,
  createOperatorRegistry,
  evaluateModifierStack,
  evaluatedOrco,
  identity4,
  modifierDisabledMessage,
  modifierDisabledReason,
  modifierObjectTypes,
  registerBuiltinModifiers,
  type ModifierData,
  type ModifierDisabledContext,
  type OperatorContext,
} from '../src';

/*
 * Blender's is_disabled of each modifier type (MOD_*.cc in Blender 4.2): a modifier that can do
 * nothing with its parameters (no object of the type it needs, a factor of 0, 0 subdivision
 * levels, …) is left out of the stack's evaluation without an error (BKE_modifier_is_enabled), and
 * Apply refuses it with "Modifier is disabled, skipping apply" (object_modifier.cc,
 * modifier_apply_obdata), keeping it.
 */

registerBuiltinModifiers();

const modifier = (type: string, params: Record<string, unknown> = {}): ModifierData => ({
  id: `m-${type}`,
  name: type,
  type,
  show_viewport: true,
  show_render: true,
  show_in_editmode: true,
  show_expanded: true,
  params,
});

describe("Blender's is_disabled per modifier type", () => {
  const types: Record<string, string> = {
    mesh: 'MESH',
    text: 'FONT',
    path: 'CURVE',
    rig: 'ARMATURE',
    e: 'EMPTY',
  };
  const ctx = (forRender = false): ModifierDisabledContext => ({
    forRender,
    objectType: (id) => types[id] ?? null,
    objectName: (id) => id.toUpperCase(),
  });
  const reason = (type: string, params: Record<string, unknown>, forRender = false) =>
    modifierDisabledReason(modifier(type, params), ctx(forRender));

  it('disables a modifier without the object of the type it needs', () => {
    expect(reason('BOOLEAN', {})).toBe('has no object');
    expect(reason('BOOLEAN', { object: 'gone' })).toBe('has no object');
    expect(reason('BOOLEAN', { object: 'text' })).toBe("has an object, 'TEXT', that is not a mesh");
    expect(reason('BOOLEAN', { object: 'mesh' })).toBeNull();
    expect(reason('ARMATURE', {})).toBe('has no object');
    expect(reason('ARMATURE', { object: 'mesh' })).toBe("has an object, 'MESH', that is not an armature");
    expect(reason('ARMATURE', { object: 'rig' })).toBeNull();
    expect(reason('CURVE', { object: 'text' })).toBe("has an object, 'TEXT', that is not a curve");
    expect(reason('CURVE', { object: 'path' })).toBeNull();
    expect(reason('SHRINKWRAP', {})).toBe('has no target');
    expect(reason('SHRINKWRAP', { target: 'e' })).toBe("has a target, 'E', that is not a mesh");
    expect(reason('SHRINKWRAP', { target: 'text' })).toBe("has a target, 'TEXT', that is not a mesh");
    expect(reason('SHRINKWRAP', { target: 'mesh' })).toBeNull();
    // the caps of an Array are optional: only one that is not a mesh disables it
    expect(reason('ARRAY', {})).toBeNull();
    expect(reason('ARRAY', { start_cap: 'gone', end_cap: 'mesh' })).toBeNull();
    expect(reason('ARRAY', { start_cap: 'path' })).toBe("has a start cap, 'PATH', that is not a mesh");
    expect(reason('ARRAY', { end_cap: 'e' })).toBe("has an end cap, 'E', that is not a mesh");
  });

  it('disables a modifier whose factors leave nothing to do', () => {
    expect(reason('BEVEL', { width: 0 })).toBe('has a width of 0');
    expect(reason('BEVEL', {})).toBeNull();
    expect(reason('DISPLACE', { strength: 0 })).toBe('has a strength of 0');
    expect(reason('DISPLACE', { direction: 'RGB_TO_XYZ', texture_type: 'NONE' })).toBe(
      'displaces along RGB_TO_XYZ without a texture (texture_type NONE)',
    );
    expect(reason('DISPLACE', { direction: 'RGB_TO_XYZ' })).toBeNull();
    expect(reason('DISPLACE', { texture_type: 'NONE' })).toBeNull();
    for (const type of ['SMOOTH', 'CAST']) {
      expect(reason(type, { factor: 0 })).toBe('has a factor of 0');
      expect(reason(type, { use_x: false, use_y: false, use_z: false })).toBe(
        'uses no axis (use_x, use_y and use_z are off)',
      );
      expect(reason(type, { use_x: false, use_y: false })).toBeNull();
    }
  });

  it('disables a Subdivision Surface with 0 levels for the mode evaluated', () => {
    expect(reason('SUBSURF', { levels: 0, render_levels: 2 })).toBe('has 0 viewport levels (levels)');
    expect(reason('SUBSURF', { levels: 0, render_levels: 2 }, true)).toBeNull();
    expect(reason('SUBSURF', { levels: 1, render_levels: 0 })).toBeNull();
    expect(reason('SUBSURF', { levels: 1, render_levels: 0 }, true)).toBe(
      'has 0 render levels (render_levels)',
    );
  });

  it('never disables the types Blender has no is_disabled for', () => {
    for (const type of [
      'BUILD',
      'DECIMATE',
      'EDGE_SPLIT',
      'MIRROR',
      'SCREW',
      'SIMPLE_DEFORM',
      'SMOOTH_BY_ANGLE',
      'SOLIDIFY',
      'TRIANGULATE',
      'WAVE',
      'WELD',
      'WIREFRAME',
    ])
      expect(reason(type, {}), type).toBeNull();
  });
});

describe('the modifier stack leaves disabled modifiers out', () => {
  const quad = () =>
    createMesh({
      positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
      faces: [[0, 1, 2, 3]],
    });
  const stack = (mods: ModifierData[], over: Record<string, unknown> = {}) =>
    evaluateModifierStack(quad(), mods, {
      frame: 1,
      objectMatrix: identity4(),
      getObjectMesh: () => null,
      forRender: false,
      editMode: false,
      ...over,
    });

  it('without an error, as Blender evaluates it', () => {
    // RGB_TO_XYZ without a texture would push every vertex by (1 - mid_level) · strength
    const r = stack([modifier('DISPLACE', { direction: 'RGB_TO_XYZ', texture_type: 'NONE', strength: 2 })]);
    expect(r.errors).toEqual([]);
    expect(Array.from(r.mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const pushed = stack([modifier('DISPLACE', { direction: 'X', texture_type: 'NONE', strength: 2 })]);
    expect(pushed.mesh.positions[0]).toBe(1);
  });

  it('by the types of the objects its parameters name, where the context gives them', () => {
    // a mesh object as the armature: the Armature modifier is disabled, not failing
    const r = stack([modifier('ARMATURE', { object: 'cube' })], {
      getObjectType: (id: string) => (id === 'cube' ? 'MESH' : null),
      getArmature: () => null,
    });
    expect(r.errors).toEqual([]);
    // without object types, what is not certain disables nothing: the modifier reports its error
    const unknown = stack([modifier('ARMATURE', { object: 'cube' })], { getArmature: () => null });
    expect(unknown.errors.map((e) => e.message)).toEqual([
      'armature object not found (or it is not an armature)',
    ]);
  });

  it('with the render levels of a Subdivision Surface for renders', () => {
    const mods = [modifier('SUBSURF', { levels: 0, render_levels: 1 })];
    expect(stack(mods).mesh.faces.length).toBe(1);
    expect(stack(mods, { forRender: true }).mesh.faces.length).toBe(4);
  });
});

describe('Apply refuses a disabled modifier, as Blender', () => {
  function setup() {
    const doc = SceneDoc.create({ empty: true });
    const reg = createOperatorRegistry();
    const ctx: OperatorContext = {
      doc,
      state: createEditorState(),
      origin: doc.origin,
      source: 'test',
      report: () => undefined,
    };
    const run = (id: string, params?: unknown) => reg.run<{ name: string }>(ctx, id, params);
    expect(run('mesh.primitive_cube_add', { name: 'Box' }).ok).toBe(true);
    const box = ctx.state.activeId!;
    const mesh = () => doc.getMesh(doc.getObject(box)!.data!)!;
    const names = () => doc.getObject(box)!.modifiers.map((m) => m.name);
    return { doc, ctx, run, box, mesh, names };
  }

  it("with Blender's message and code FAILED, keeping the modifier and the mesh", () => {
    const { ctx, doc, run, box, mesh, names } = setup();
    expect(run('curve.primitive_bezier_curve_add', {}).ok).toBe(true);
    const path = ctx.state.activeId!;
    const before = mesh();
    const refused = (label: string, name: string, why: string) => {
      const r = run('object.modifier_apply', { object: box, modifier: name });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('FAILED');
      expect(r.error).toBe(
        `Modifier is disabled, skipping apply: the ${label} modifier '${name}' ${why}, so it changes ` +
          'nothing; change it with object.modifier_set or remove it with object.modifier_remove',
      );
      expect(names()).toContain(name);
      expect(mesh()).toEqual(before);
      expect(run('object.modifier_remove', { object: box, modifier: name }).ok).toBe(true);
    };
    expect(run('object.modifier_add', { object: box, type: 'BOOLEAN' }).ok).toBe(true);
    refused('Boolean', 'Boolean', 'has no object');
    // an object that became another type: a curve converted to a mesh in place
    expect(run('object.modifier_add', { object: box, type: 'CURVE', params: { object: path } }).ok).toBe(
      true,
    );
    Object.assign(ctx.state, { selectedIds: [path], activeId: path });
    expect(run('object.convert', { target: 'MESH' }).ok).toBe(true);
    expect(doc.getObject(path)!.type).toBe('MESH');
    refused('Curve', 'Curve', "has an object, 'BezierCurve', that is not a curve");
    // the viewport's settings decide, as in Blender (a Subdivision Surface with render levels)
    run('object.modifier_add', { object: box, type: 'SUBSURF', params: { levels: 0, render_levels: 2 } });
    const sub = run('object.modifier_apply', { object: box, modifier: 'Subdivision' });
    expect(sub.error).toMatch(/^Modifier is disabled, skipping apply: .* has 0 viewport levels \(levels\)/);
    expect(names()).toEqual(['Subdivision']);
  });

  it('skips and keeps the disabled modifiers before the one it applies', () => {
    const { run, box, mesh, names } = setup();
    run('object.modifier_add', { object: box, type: 'BOOLEAN' });
    run('object.modifier_add', { object: box, type: 'SUBSURF', params: { levels: 1 } });
    const r = run('object.modifier_apply', { object: box, modifier: 'Subdivision' });
    expect(r.ok).toBe(true);
    expect(mesh().faces.length).toBe(24);
    expect(names()).toEqual(['Boolean']);
  });

  it('applies a modifier hidden in the viewport, as Blender does, and refuses one that is disabled', () => {
    // object_modifier.cc (ED_object_modifier_apply): a modifier not enabled in the viewport is
    // evaluated with "md_eval->mode |= eModifierMode_Realtime" ("Force mode on the evaluated
    // modifier, enforcing the modifier evaluation in the apply() functions"), then
    // modifier_apply_obdata refuses it when is_disabled
    const { run, box, mesh, names } = setup();
    run('object.modifier_add', { object: box, type: 'BOOLEAN' });
    run('object.modifier_add', { object: box, type: 'SUBSURF', params: { levels: 1 } });
    for (const modifier of ['Boolean', 'Subdivision'])
      expect(run('object.modifier_set', { object: box, modifier, show_viewport: false }).ok).toBe(true);
    const before = mesh();
    const refused = run('object.modifier_apply', { object: box, modifier: 'Boolean' });
    expect(refused).toMatchObject({
      ok: false,
      code: 'FAILED',
      error:
        "Modifier is disabled, skipping apply: the Boolean modifier 'Boolean' has no object, so it changes " +
        'nothing; change it with object.modifier_set or remove it with object.modifier_remove',
    });
    expect(mesh()).toEqual(before);
    const r = run('object.modifier_apply', { object: box, modifier: 'Subdivision' });
    expect(r.ok).toBe(true);
    expect(mesh().faces.length).toBe(24);
    expect(names()).toEqual(['Boolean']);
  });

  it('converts an object with a disabled modifier to its evaluated mesh', () => {
    const { ctx, doc, run, box, mesh } = setup();
    run('object.modifier_add', {
      object: box,
      type: 'DISPLACE',
      params: { direction: 'RGB_TO_XYZ', texture_type: 'NONE' },
    });
    const before = mesh();
    expect(new SceneEvaluator(doc).evaluate(1).byId.get(box)!.modifierErrors).toEqual([]);
    ctx.state.selectedIds = [box];
    const r = run('object.convert', { target: 'MESH' });
    expect(r.ok).toBe(true);
    const converted = doc.getObject(ctx.state.activeId!)!;
    expect(converted.modifiers).toEqual([]);
    expect(Array.from(doc.getMesh(converted.data!)!.positions)).toEqual(Array.from(before.positions));
  });
});

describe("parameters naming an object take the types Blender's setters accept", () => {
  /*
   * rna_modifier.cc (Blender 4.2) stores no object of another type in these parameters:
   * `modifier_object_set` keeps the old pointer unless `ob->type == type` (RNA_MOD_OBJECT_SET with
   * OB_MESH for the Boolean object, the Array caps and the Shrinkwrap target, OB_ARMATURE for the
   * Armature object, OB_CURVES_LEGACY for the Curve object); the others take any object. The
   * operators refuse such an object with the type the parameter takes.
   */
  function scene() {
    const doc = SceneDoc.create({ empty: true });
    const reg = createOperatorRegistry();
    const ctx: OperatorContext = {
      doc,
      state: createEditorState(),
      origin: doc.origin,
      source: 'test',
      report: () => undefined,
    };
    const run = (id: string, params?: unknown) => reg.run<{ name: string }>(ctx, id, params);
    const add = (id: string, params: Record<string, unknown> = {}) => {
      expect(run(id, params).ok).toBe(true);
      return ctx.state.activeId!;
    };
    const ids = {
      box: add('mesh.primitive_cube_add', { name: 'Box' }),
      ball: add('mesh.primitive_uv_sphere_add', { location: [3, 0, 0] }),
      label: add('object.text_add', { body: 'Hi' }),
      path: add('curve.primitive_bezier_curve_add'),
      rig: add('object.armature_add'),
      empty: add('object.empty_add'),
      camera: add('object.camera_add'),
    };
    const modifiers = () => doc.getObject(ids.box)!.modifiers;
    return { doc, run, ids, modifiers };
  }

  it('object.modifier_add refuses an object of another type with the type it takes (INVALID_PARAMS)', () => {
    const { doc, run, ids, modifiers } = scene();
    const name = (id: string) => doc.getObject(id)!.name;
    expect([ids.ball, ids.label, ids.path, ids.rig, ids.empty, ids.camera].map(name)).toEqual([
      'Sphere',
      'Text',
      'BezierCurve',
      'Armature',
      'Empty',
      'Camera',
    ]);
    const cases: [string, Record<string, unknown>, string][] = [
      [
        'BOOLEAN',
        { object: ids.label },
        "Parameter 'object' of the Boolean modifier takes a mesh object; 'Text' is a text object " +
          '(object.convert with target MESH makes it one)',
      ],
      [
        'SHRINKWRAP',
        { target: 'BezierCurve' },
        "Parameter 'target' of the Shrinkwrap modifier takes a mesh object; 'BezierCurve' is a curve object " +
          '(object.convert with target MESH makes it one)',
      ],
      [
        'ARRAY',
        { start_cap: ids.empty },
        "Parameter 'start_cap' of the Array modifier takes a mesh object; 'Empty' is an empty object",
      ],
      [
        'ARRAY',
        { end_cap: ids.camera },
        "Parameter 'end_cap' of the Array modifier takes a mesh object; 'Camera' is a camera object",
      ],
      [
        'ARMATURE',
        { object: ids.ball },
        "Parameter 'object' of the Armature modifier takes an armature object; 'Sphere' is a mesh object",
      ],
      [
        'CURVE',
        { object: ids.label },
        "Parameter 'object' of the Curve modifier takes a curve object; 'Text' is a text object " +
          '(object.convert with target CURVE makes it one)',
      ],
      [
        'CURVE',
        { object: ids.rig },
        "Parameter 'object' of the Curve modifier takes a curve object; 'Armature' is an armature object",
      ],
    ];
    for (const [type, params, error] of cases) {
      const r = run('object.modifier_add', { object: ids.box, type, params });
      expect(r, `${type} ${JSON.stringify(params)}`).toMatchObject({
        ok: false,
        code: 'INVALID_PARAMS',
        error,
      });
    }
    expect(modifiers()).toEqual([]);
  });

  it('takes the types they accept, and any object where Blender takes any', () => {
    const { run, ids, modifiers } = scene();
    const cases: [string, Record<string, unknown>][] = [
      ['BOOLEAN', { object: ids.ball }],
      ['SHRINKWRAP', { target: ids.ball }],
      ['ARRAY', { start_cap: ids.ball, end_cap: ids.ball, offset_object: ids.camera }],
      ['ARMATURE', { object: ids.rig }],
      ['CURVE', { object: ids.path }],
      ['MIRROR', { mirror_object: ids.empty }],
      ['CAST', { object: ids.label }],
      ['SIMPLE_DEFORM', { origin: ids.rig }],
      ['WAVE', { start_position_object: ids.path }],
      ['SCREW', { object: ids.camera }],
    ];
    for (const [type, params] of cases) {
      const r = run('object.modifier_add', { object: ids.box, type, params });
      expect(r.ok, `${type}: ${r.error}`).toBe(true);
      const stored = modifiers().at(-1)!.params;
      for (const [k, v] of Object.entries(params)) expect(stored[k]).toBe(v);
    }
    expect(modifierObjectTypes('BOOLEAN', 'object')).toEqual(['MESH']);
    expect(modifierObjectTypes('ARRAY', 'end_cap')).toEqual(['MESH']);
    expect(modifierObjectTypes('ARRAY', 'offset_object')).toBeNull();
    expect(modifierObjectTypes('MIRROR', 'mirror_object')).toBeNull();
  });

  it('object.modifier_set refuses one too and keeps the object the parameter had', () => {
    const { run, ids, modifiers } = scene();
    expect(
      run('object.modifier_add', { object: ids.box, type: 'BOOLEAN', params: { object: ids.ball } }).ok,
    ).toBe(true);
    const r = run('object.modifier_set', {
      object: ids.box,
      modifier: 'Boolean',
      params: { object: 'Camera' },
    });
    expect(r).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS',
      error: "Parameter 'object' of the Boolean modifier takes a mesh object; 'Camera' is a camera object",
    });
    expect(modifiers()[0].params.object).toBe(ids.ball);
  });
});

describe('the evaluation, Convert and Apply leave out a modifier whose object is of the wrong type', () => {
  /*
   * The scene's evaluation gives modifiers the types of the objects they name
   * (ModifierContext.getObjectType), as Blender's is_disabled reads them: an Array whose start cap
   * is not a mesh is disabled (MOD_array.cc), as Apply finds it. Such caps cannot be set any more
   * (Blender's setter refuses them); they are written here as an older document has them, or as an
   * object that changed type afterwards has them.
   */
  function capped(kind: 'armature' | 'curve' | 'mesh' | 'text' | 'empty' | 'camera') {
    const doc = SceneDoc.create({ empty: true });
    const reg = createOperatorRegistry();
    const ctx: OperatorContext = {
      doc,
      state: createEditorState(),
      origin: doc.origin,
      source: 'test',
      report: () => undefined,
    };
    const run = (id: string, params?: unknown) => reg.run(ctx, id, params);
    expect(run('mesh.primitive_cube_add', { name: 'Box' }).ok).toBe(true);
    const box = ctx.state.activeId!;
    const op = {
      armature: 'object.armature_add',
      curve: 'curve.primitive_bezier_curve_add',
      text: 'object.text_add',
      empty: 'object.empty_add',
      camera: 'object.camera_add',
    }[kind as string];
    expect(run(op ?? 'mesh.primitive_cube_add', { location: [0, 0, 3] }).ok).toBe(true);
    const cap = ctx.state.activeId!;
    expect(run('object.modifier_add', { object: box, type: 'ARRAY', params: { count: 2 } }).ok).toBe(true);
    const array = doc.getObject(box)!.modifiers[0];
    doc.updateObject(box, { modifiers: [{ ...array, params: { ...array.params, start_cap: cap } }] });
    const evaluated = new SceneEvaluator(doc).evaluate(1).byId.get(box)!;
    const apply = run('object.modifier_apply', { object: box, modifier: 'Array' });
    return { verts: evaluated.mesh!.positions.length / 3, errors: evaluated.modifierErrors, apply };
  }

  it('leaves out an Array whose start cap is not a mesh', () => {
    const mesh = capped('mesh');
    expect(mesh.verts).toBe(24);
    expect(mesh.apply.ok).toBe(true);
    for (const kind of ['armature', 'curve', 'text', 'empty', 'camera'] as const) {
      const r = capped(kind);
      expect(r.verts, kind).toBe(8);
      expect(r.errors).toEqual([]);
      expect(r.apply.error).toMatch(
        new RegExp(
          `^Modifier is disabled, skipping apply: the Array modifier 'Array' has a start cap, '\\w+', that is not a mesh`,
        ),
      );
    }
  });

  function scene() {
    const doc = SceneDoc.create({ empty: true });
    const reg = createOperatorRegistry();
    const ctx: OperatorContext = {
      doc,
      state: createEditorState(),
      origin: doc.origin,
      source: 'test',
      report: () => undefined,
    };
    const run = (id: string, params?: unknown) => reg.run(ctx, id, params);
    const add = (id: string, params: Record<string, unknown> = {}) => {
      expect(run(id, params).ok).toBe(true);
      return ctx.state.activeId!;
    };
    return { doc, ctx, run, add };
  }

  it('converts an object whose Curve modifier names a curve converted to a mesh, as the viewport shows it', () => {
    // Blender's MOD_curve.cc is_disabled: `!cmd->object || cmd->object->type != OB_CURVES_LEGACY`
    const { doc, ctx, run, add } = scene();
    const path = add('curve.primitive_bezier_curve_add');
    const box = add('mesh.primitive_cube_add', { name: 'Box', location: [0, 3, 0] });
    expect(run('object.modifier_add', { object: box, type: 'CURVE', params: { object: path } }).ok).toBe(
      true,
    );
    Object.assign(ctx.state, { selectedIds: [path], activeId: path });
    expect(run('object.convert', { target: 'MESH' }).ok).toBe(true);
    expect(doc.getObject(path)!.type).toBe('MESH');
    const base = Array.from(doc.getMesh(doc.getObject(box)!.data!)!.positions);
    // the viewport leaves the modifier out, without an error
    const shown = new SceneEvaluator(doc).evaluate(1).byId.get(box)!;
    expect(shown.modifierErrors).toEqual([]);
    expect(Array.from(shown.mesh!.positions)).toEqual(base);
    // Apply refuses it, and Convert bakes what the viewport shows
    expect(run('object.modifier_apply', { object: box, modifier: 'Curve' }).error).toMatch(
      /^Modifier is disabled, skipping apply: the Curve modifier 'Curve' has an object, 'BezierCurve', that is not a curve,/,
    );
    Object.assign(ctx.state, { selectedIds: [box], activeId: box });
    const converted = run('object.convert', { target: 'MESH' });
    expect(converted.ok, converted.error).toBe(true);
    expect(doc.getObject(box)!.modifiers).toEqual([]);
    expect(Array.from(doc.getMesh(doc.getObject(box)!.data!)!.positions)).toEqual(base);
  });

  it('leaves out a Boolean or Shrinkwrap whose object is a text, and an Armature whose object is a mesh', () => {
    const { doc, run, add } = scene();
    const label = add('object.text_add', { body: 'Hi', location: [0, 0, 0.5] });
    const ball = add('mesh.primitive_uv_sphere_add', { location: [3, 0, 0] });
    const box = add('mesh.primitive_cube_add', { name: 'Box' });
    const base = Array.from(doc.getMesh(doc.getObject(box)!.data!)!.positions);
    const set = (type: string, params: Record<string, unknown>) => {
      expect(run('object.modifier_add', { object: box, type }).ok).toBe(true);
      const m = doc.getObject(box)!.modifiers[0];
      // as an older document has it: the operators refuse these objects (INVALID_PARAMS)
      doc.updateObject(box, { modifiers: [{ ...m, params: { ...m.params, ...params } }] });
      const shown = new SceneEvaluator(doc).evaluate(1).byId.get(box)!;
      expect(shown.modifierErrors, type).toEqual([]);
      expect(Array.from(shown.mesh!.positions), type).toEqual(base);
      expect(run('object.modifier_remove', { object: box, modifier: m.name }).ok).toBe(true);
    };
    set('BOOLEAN', { object: label });
    set('SHRINKWRAP', { target: label });
    set('ARMATURE', { object: ball });
  });

  it('leaves it out of the undeformed coordinates too (GENERATED texture coordinates)', () => {
    // an Array with a text as its start cap (disabled, MOD_array.cc) and a deforming Displace: the
    // undeformed coordinates leave the Array out as the evaluated mesh does, and match it
    const { doc, run, add } = scene();
    const label = add('object.text_add', { body: 'Hi', location: [0, 0, 3] });
    const box = add('mesh.primitive_cube_add', { name: 'Box' });
    expect(run('object.modifier_add', { object: box, type: 'ARRAY', params: { count: 2 } }).ok).toBe(true);
    expect(run('object.modifier_add', { object: box, type: 'DISPLACE', params: { strength: 0.1 } }).ok).toBe(
      true,
    );
    const [array, displace] = doc.getObject(box)!.modifiers;
    doc.updateObject(box, {
      modifiers: [{ ...array, params: { ...array.params, start_cap: label } }, displace],
    });
    const scene1 = new SceneEvaluator(doc).evaluate(1);
    const ev = scene1.byId.get(box)!;
    expect(ev.mesh!.positions.length / 3).toBe(8);
    const orco = evaluatedOrco(doc, scene1, ev, false);
    expect(orco).not.toBeNull();
    expect(orco!.length).toBe(ev.mesh!.positions.length);
  });

  it('names why in the words Apply, get_scene and the Modifiers tab use', () => {
    const ctx: ModifierDisabledContext = { forRender: false, objectType: () => null };
    expect(modifierDisabledMessage({ ...modifier('BOOLEAN'), name: 'Cut' }, ctx)).toBe(
      "the Boolean modifier 'Cut' has no object, so it changes nothing",
    );
    expect(modifierDisabledMessage(modifier('SUBSURF', { levels: 2 }), ctx)).toBeNull();
  });
});
