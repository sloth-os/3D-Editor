import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  SceneDoc,
  compose4,
  createEditorState,
  createOperatorRegistry,
  evaluateFCurve,
  fcurveKey,
  invert4,
  multiply4,
  rotationFromEuler,
  type Mat4,
  type OperatorContext,
  type Vec3,
} from '../src';
import { matrixToCompatibleEuler } from '../src/constraints/math';

/*
 * Transforms write only the channels (location, rotation_euler, scale) they change, keep the
 * others bit for bit, and keep euler angles continuous (SceneDoc.setWorldMatrix).
 */

const deg = Math.PI / 180;

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
  const run = (id: string, params?: unknown) => {
    const r = reg.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r;
  };
  const get = (name: string) => doc.findObjectByName(name)!;
  const add = (
    name: string,
    init: { location?: Vec3; rotation?: Vec3; scale?: Vec3; parent?: string } = {},
  ): string =>
    doc.addObject({
      type: 'EMPTY',
      name,
      location: init.location ?? [0, 0, 0],
      rotation_euler: init.rotation ?? [0, 0, 0],
      scale: init.scale ?? [1, 1, 1],
      parent: init.parent ? get(init.parent).id : null,
    });
  const select = (...names: string[]) => {
    const ids = names.map((n) => get(n).id);
    ctx.state.selectedIds = ids;
    ctx.state.activeId = ids[ids.length - 1];
  };
  return { doc, ctx, run, add, get, select };
}

/** The keys of each object's map (by object name) that the Yjs transactions of `fn` set. */
function objectWrites(doc: SceneDoc, fn: () => void): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  const objects = doc.map('objects');
  const listener = (tr: Y.Transaction) => {
    for (const [type, keys] of tr.changed) {
      if (!(type instanceof Y.Map) || type.parent !== objects) continue;
      const name = String(type.get('name'));
      for (const k of keys) if (k !== null) (out[name] ??= new Set()).add(k);
    }
  };
  doc.ydoc.on('afterTransaction', listener);
  try {
    fn();
  } finally {
    doc.ydoc.off('afterTransaction', listener);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

/** Expects two matrices to be equal up to rounding. */
function expectMatrix(actual: Mat4, expected: Mat4, what: string) {
  actual.forEach((v, i) => expect(v, `${what}: matrix[${i}]`).toBeCloseTo(expected[i], 10));
}

/** Expects euler angles (radians) to be the given degrees. */
function expectDegrees(actual: Vec3, expected: Vec3, what: string) {
  actual.forEach((v, i) => expect(v / deg, `${what}: rotation[${i}] in degrees`).toBeCloseTo(expected[i], 9));
}

/** `world` rotated by `rot` about its own origin. */
function turned(rot: Vec3, world: Mat4): Mat4 {
  const m = multiply4(rotationFromEuler(rot), world);
  m[12] = world[12];
  m[13] = world[13];
  m[14] = world[14];
  return m;
}

// rotations and scales a matrix decomposition gives back as other, equivalent values
const CASES: { name: string; rotation: Vec3; scale: Vec3 }[] = [
  { name: 'Y beyond 90°', rotation: [0, 120 * deg, 0], scale: [1, 1, 1] },
  { name: 'X beyond 180°', rotation: [190 * deg, 0, 0], scale: [1, 1, 1] },
  { name: 'Z beyond -180°', rotation: [0, 0, -200 * deg], scale: [1, 1, 1] },
  { name: 'gimbal lock', rotation: [10 * deg, 90 * deg, 30 * deg], scale: [1, 1, 1] },
  { name: 'near gimbal lock', rotation: [10 * deg, 89.99 * deg, 30 * deg], scale: [1, 1, 1] },
  { name: 'two turns and 10°', rotation: [730 * deg, 0, 0], scale: [1, 1, 1] },
  { name: 'a negative Y scale', rotation: [0, 0, 0], scale: [1, -1, 1] },
  { name: 'a negative X scale', rotation: [0, 0, 30 * deg], scale: [-2, 3, 0.5] },
  { name: 'all scales negative', rotation: [10 * deg, 25 * deg, 40 * deg], scale: [-1, -1, -1] },
  { name: 'a scale of 0', rotation: [0, 0, 30 * deg], scale: [0, 1, 1] },
  {
    name: 'a rotated, unevenly scaled object',
    rotation: [30 * deg, 45 * deg, 60 * deg],
    scale: [1.5, 0.5, 2],
  },
];

describe('a Move writes only the location, whatever the rotation and scale', () => {
  for (const c of CASES)
    it(c.name, () => {
      const { doc, run, add, get, select } = setup();
      add('A', { location: [1, 2, 3], rotation: c.rotation, scale: c.scale });
      select('A');
      const writes = objectWrites(doc, () => run('transform.translate', { value: [1, 0, 0] }));
      expect(get('A').rotation_euler).toEqual(c.rotation);
      expect(get('A').scale).toEqual(c.scale);
      expect(get('A').location).toEqual([2, 2, 3]);
      expect(writes).toEqual({ A: ['location'] });
    });

  it('children of rotated, unevenly scaled parents', () => {
    const { doc, run, add, get, select } = setup();
    add('P', { location: [3, -2, 1], rotation: [30 * deg, -50 * deg, 75 * deg], scale: [0.1, 10, 2.5] });
    add('Q', {
      location: [0, 1, 0],
      rotation: [-20 * deg, 15 * deg, 100 * deg],
      scale: [3, 0.3, 1],
      parent: 'P',
    });
    const children: { name: string; rotation: Vec3; scale: Vec3 }[] = [
      { name: 'C', rotation: [10 * deg, 20 * deg, 30 * deg], scale: [1.5, 0.5, 2] },
      { name: 'D', rotation: [0, 120 * deg, 0], scale: [1, -1, 1] },
      { name: 'E', rotation: [-75 * deg, 33 * deg, 190 * deg], scale: [0.7, 4, 0.25] },
    ];
    for (const c of children)
      add(c.name, { location: [1, 2, 3], rotation: c.rotation, scale: c.scale, parent: 'Q' });
    for (const c of children) {
      const before = doc.worldMatrix(get(c.name).id);
      select(c.name);
      const writes = objectWrites(doc, () => run('transform.translate', { value: [0, 0, 2] }));
      expect(get(c.name).rotation_euler, c.name).toEqual(c.rotation);
      expect(get(c.name).scale, c.name).toEqual(c.scale);
      expect(writes, c.name).toEqual({ [c.name]: ['location'] });
      const moved = before.slice();
      moved[14] += 2;
      expectMatrix(doc.worldMatrix(get(c.name).id), moved, c.name);
    }
  });
});

describe('a rotation about the object’s own origin writes only its rotation', () => {
  for (const c of CASES)
    it(c.name, () => {
      const { doc, ctx, run, add, get, select } = setup();
      add('P', { location: [5, 0, 0], rotation: [0, 0, 40 * deg], scale: [2, 2, 2] });
      add('A', { location: [1.1, -2.3, 3.7], rotation: c.rotation, scale: c.scale });
      add('B', { location: [0.3, 0.7, -0.9], rotation: c.rotation, scale: c.scale, parent: 'P' });
      for (const name of ['A', 'B']) {
        const before = doc.worldMatrix(get(name).id);
        select(name);
        const writes = objectWrites(doc, () =>
          run('transform.rotate', { value: 20 * deg, orient_axis: 'X' }),
        );
        expect(get(name).scale, name).toEqual(c.scale);
        expectMatrix(doc.worldMatrix(get(name).id), turned([20 * deg, 0, 0], before), name);
        expect(writes, name).toEqual({ [name]: ['rotation_euler'] });
      }
      // both at once, each about its own origin
      ctx.state.pivotPoint = 'INDIVIDUAL_ORIGINS';
      select('A', 'B');
      const writes = objectWrites(doc, () => run('transform.rotate', { value: -35 * deg, orient_axis: 'Y' }));
      expect(writes, 'individual origins').toEqual({ A: ['rotation_euler'], B: ['rotation_euler'] });
      // about the 3D cursor the origin moves, so the location changes too
      ctx.state.pivotPoint = 'CURSOR';
      select('A');
      expect(
        objectWrites(doc, () => run('transform.rotate', { value: 10 * deg, orient_axis: 'Z' })),
        'about the 3D cursor',
      ).toEqual({ A: ['location', 'rotation_euler'] });
    });
});

describe('a scale about the object’s own origin writes only its scale, keeping the sign of each axis', () => {
  for (const c of CASES.filter((k) => k.scale.every((v) => v !== 0)))
    it(c.name, () => {
      const { doc, run, add, get, select } = setup();
      add('A', { location: [1.1, -2.3, 3.7], rotation: c.rotation, scale: c.scale });
      select('A');
      for (const f of [2, -1]) {
        const before = get('A').scale;
        const writes = objectWrites(doc, () => run('transform.resize', { value: [f, f, f] }));
        expect(get('A').rotation_euler, `×${f}`).toEqual(c.rotation);
        get('A').scale.forEach((v, i) => expect(v, `×${f}`).toBeCloseTo(before[i] * f, 12));
        expect(writes, `×${f}`).toEqual({ A: ['scale'] });
      }
    });
});

describe('mirroring flips the scale of the object’s axis it mirrors along, keeping the rotation', () => {
  const cases: { name: string; rotation: Vec3; scale: Vec3; mirror: Vec3; expected: Vec3 }[] = [
    {
      name: 'unrotated, along X',
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      mirror: [-1, 1, 1],
      expected: [-1, 1, 1],
    },
    // the world's X axis is the object's Y axis
    {
      name: 'turned 90° about Z, along X',
      rotation: [0, 0, 90 * deg],
      scale: [1, 1, 1],
      mirror: [-1, 1, 1],
      expected: [1, -1, 1],
    },
    {
      name: 'a negative Y scale, along X',
      rotation: [0, 0, 0],
      scale: [1, -1, 1],
      mirror: [-1, 1, 1],
      expected: [-1, -1, 1],
    },
    // turned about Y, the object's Y axis is the world's
    {
      name: 'Y beyond 90°, along Y',
      rotation: [0, 120 * deg, 0],
      scale: [2, 2, 2],
      mirror: [1, -1, 1],
      expected: [2, -2, 2],
    },
  ];
  for (const c of cases)
    it(c.name, () => {
      const { doc, run, add, get, select } = setup();
      add('A', { location: [1, 2, 3], rotation: c.rotation, scale: c.scale });
      const before = doc.worldMatrix(get('A').id);
      select('A');
      const writes = objectWrites(doc, () => run('transform.resize', { value: c.mirror }));
      expect(get('A').rotation_euler).toEqual(c.rotation);
      get('A').scale.forEach((v, i) => expect(v).toBeCloseTo(c.expected[i], 12));
      expect(writes).toEqual({ A: ['scale'] });
      const mirrored = multiply4(compose4([0, 0, 0], [0, 0, 0], c.mirror), before);
      [12, 13, 14].forEach((k) => (mirrored[k] = before[k]));
      expectMatrix(doc.worldMatrix(get('A').id), mirrored, c.name);
    });
});

describe('children of unevenly scaled parents', () => {
  // the parent's inverse amplifies rounding by about the ratio of its longest to its shortest axis;
  // the tolerance within which the child's rotation and scale count as unchanged grows with it
  for (const scale of [
    [1000, 0.01, 1],
    [1e4, 1e-3, 1],
  ] as Vec3[])
    it(`a rotation by 180° about an axis of a parent scaled ${scale.join(', ')} writes only the rotation`, () => {
      const { doc, run, add, get, select } = setup();
      add('P', { location: [1, 2, 3], rotation: [0, 0, 25 * deg], scale });
      add('C', {
        location: [0.3, 0.2, 0.1],
        rotation: [10 * deg, 20 * deg, 30 * deg],
        scale: [1.5, 0.5, 2],
        parent: 'P',
      });
      const before = doc.worldMatrix(get('C').id);
      select('C');
      // the parent's Z axis is the world's: the child turns about it without changing its shape
      const writes = objectWrites(doc, () => run('transform.rotate', { value: Math.PI, orient_axis: 'Z' }));
      expect(writes).toEqual({ C: ['rotation_euler'] });
      expect(get('C').scale).toEqual([1.5, 0.5, 2]);
      get('C').rotation_euler.forEach((v, i) => expect(v / deg).toBeCloseTo([10, 20, 210][i], 6));
      const after = doc.worldMatrix(get('C').id);
      const expected = turned([0, 0, Math.PI], before);
      const size = Math.max(...expected.map(Math.abs));
      after.forEach((v, i) => expect(Math.abs(v - expected[i]), `matrix[${i}]`).toBeLessThan(1e-9 * size));
    });

  it('any other rotation also writes the scale; the rotation is the one Blender stores', () => {
    const { doc, run, add, get, select } = setup();
    add('P', { scale: [2, 1, 1] });
    add('C', { location: [1, 0, 0], rotation: [0, 0, 30 * deg], parent: 'P' });
    select('C');
    const writes = objectWrites(doc, () => run('transform.rotate', { value: 45 * deg, orient_axis: 'Z' }));
    expect(writes).toEqual({ C: ['rotation_euler', 'scale'] });
    // the child's axes turned in the world, in the parent's space: P⁻¹ · R · P · rotation
    const P = compose4([0, 0, 0], [0, 0, 0], [2, 1, 1]);
    const axes = multiply4(
      invert4(P),
      multiply4(rotationFromEuler([0, 0, 45 * deg]), multiply4(P, rotationFromEuler([0, 0, 30 * deg]))),
    );
    // Blender's Rotate stores the euler of those axes (normalized) and keeps the scale; here the
    // scale becomes their lengths, which keeps the child's world matrix up to the shear
    const blender = matrixToCompatibleEuler(axes, [0, 0, 30 * deg]);
    expectDegrees(get('C').rotation_euler, blender.map((v) => v / deg) as Vec3, 'C');
    expect(get('C').rotation_euler[2] / deg).toBeCloseTo(74.571, 3);
    get('C').scale.forEach((v, i) =>
      expect(v).toBeCloseTo(Math.hypot(axes[i * 4], axes[i * 4 + 1], axes[i * 4 + 2]), 12),
    );
    expect(get('C').scale[0]).toBeCloseTo(1.6373, 4);
    expect(get('C').scale[1]).toBeCloseTo(0.6665, 4);
  });
});

describe('a scale by −1 along two of the object’s axes is stored as a rotation by 180° about the third', () => {
  // the stored scale signs stay (Blender's Scale negates the two scales and keeps the rotation;
  // both give the same matrix)
  it('along the object’s own X and Y axes', () => {
    const { doc, add, get } = setup();
    const id = add('A', {
      location: [1, 2, 3],
      rotation: [10 * deg, 20 * deg, 30 * deg],
      scale: [1.5, 0.5, 2],
    });
    const before = doc.worldMatrix(id);
    const after = multiply4(before, compose4([0, 0, 0], [0, 0, 0], [-1, -1, 1]));
    const writes = objectWrites(doc, () => doc.setWorldMatrix(id, after));
    expect(writes).toEqual({ A: ['rotation_euler'] });
    expect(get('A').scale).toEqual([1.5, 0.5, 2]);
    expectMatrix(
      rotationFromEuler(get('A').rotation_euler),
      multiply4(
        rotationFromEuler([10 * deg, 20 * deg, 30 * deg]),
        compose4([0, 0, 0], [0, 0, 0], [-1, -1, 1]),
      ),
      'rotation',
    );
    expectMatrix(doc.worldMatrix(id), after, 'A');
  });

  it('with factors of other sizes the scale keeps its signs', () => {
    const { doc, add, get } = setup();
    const id = add('A', {
      location: [1, 2, 3],
      rotation: [10 * deg, 20 * deg, 30 * deg],
      scale: [1.5, -0.5, 2],
    });
    const before = doc.worldMatrix(id);
    const after = multiply4(before, compose4([0, 0, 0], [0, 0, 0], [1, -2, -3]));
    const writes = objectWrites(doc, () => doc.setWorldMatrix(id, after));
    expect(writes).toEqual({ A: ['rotation_euler', 'scale'] });
    get('A').scale.forEach((v, i) => expect(v).toBeCloseTo([1.5, -1, 6][i], 12));
    expectMatrix(doc.worldMatrix(id), after, 'A');
  });

  it('S −1 along X and Y of an unrotated object', () => {
    const { doc, run, add, get, select } = setup();
    add('A', { location: [1, 2, 3], scale: [1.5, 0.5, 2] });
    select('A');
    const writes = objectWrites(doc, () => run('transform.resize', { value: [-1, -1, 1] }));
    expect(writes).toEqual({ A: ['rotation_euler'] });
    expect(get('A').scale).toEqual([1.5, 0.5, 2]);
    const [x, y, z] = get('A').rotation_euler.map((v) => v / deg);
    [x, y, Math.abs(z)].forEach((v, i) => expect(v).toBeCloseTo([0, 0, 180][i], 9));
  });
});

describe('a rotation stores the euler angles closest to the stored ones', () => {
  const cases: { name: string; rotation: Vec3; axis: 'X' | 'Y' | 'Z'; by: number; expected: Vec3 }[] = [
    { name: '170° + 20°', rotation: [170 * deg, 0, 0], axis: 'X', by: 20, expected: [190, 0, 0] },
    { name: '-170° - 20°', rotation: [-170 * deg, 0, 0], axis: 'X', by: -20, expected: [-190, 0, 0] },
    { name: '720° + 10°', rotation: [720 * deg, 0, 0], axis: 'X', by: 10, expected: [730, 0, 0] },
    { name: '730° + 10°', rotation: [730 * deg, 0, 0], axis: 'X', by: 10, expected: [740, 0, 0] },
    { name: 'Z 350° + 20°', rotation: [0, 0, 350 * deg], axis: 'Z', by: 20, expected: [0, 0, 370] },
    { name: 'Y 120°, Z + 10°', rotation: [0, 120 * deg, 0], axis: 'Z', by: 10, expected: [0, 120, 10] },
    // in gimbal lock only X − Z (Y = 90°) or X + Z (Y = −90°) is defined: Z keeps its stored value
    {
      name: 'gimbal lock, Z + 10°',
      rotation: [10 * deg, 90 * deg, 30 * deg],
      axis: 'Z',
      by: 10,
      expected: [0, 90, 30],
    },
    {
      name: 'gimbal lock at -90°, Z + 10°',
      rotation: [10 * deg, -90 * deg, 30 * deg],
      axis: 'Z',
      by: 10,
      expected: [20, -90, 30],
    },
  ];
  for (const c of cases)
    it(c.name, () => {
      const { doc, run, add, get, select } = setup();
      add('A', { location: [1, 2, 3], rotation: c.rotation });
      const before = doc.worldMatrix(get('A').id);
      select('A');
      run('transform.rotate', { value: c.by * deg, orient_axis: c.axis });
      expectDegrees(get('A').rotation_euler, c.expected, c.name);
      const by = c.by * deg;
      const rot: Vec3 = [c.axis === 'X' ? by : 0, c.axis === 'Y' ? by : 0, c.axis === 'Z' ? by : 0];
      expectMatrix(doc.worldMatrix(get('A').id), turned(rot, before), c.name);
    });

  it('keyframes auto-inserted after a rotation stay continuous', () => {
    const { doc, ctx, run, add, get, select } = setup();
    add('A', { rotation: [170 * deg, 0, 0] });
    select('A');
    ctx.state.autoKeying = true;
    run('anim.keyframe_insert', { type: 'Rotation' });
    ctx.state.frame = 11;
    run('transform.rotate', { value: 20 * deg, orient_axis: 'X' });
    const key = fcurveKey({
      target_type: 'object',
      target_id: get('A').id,
      path: 'rotation_euler',
      index: 0,
    });
    const fc = doc.getFCurve(key)!;
    expect(fc.keyframes.map((k) => [k.frame, Math.round((k.value / deg) * 1e9) / 1e9])).toEqual([
      [1, 170],
      [11, 190],
    ]);
    // in between, the animation turns on through 180° (not back through 0°)
    for (const frame of [3, 6, 9]) {
      const v = evaluateFCurve(fc, frame)! / deg;
      expect(v, `frame ${frame}`).toBeGreaterThan(170);
      expect(v, `frame ${frame}`).toBeLessThan(190);
    }
  });
});

describe('parenting and clearing the parent with Keep Transform keep what the parent leaves unchanged', () => {
  for (const c of CASES)
    it(c.name, () => {
      const { doc, add, get } = setup();
      add('P', { location: [5, 0, 0] });
      add('T', { rotation: [0, 0, 90 * deg] });
      const id = add('A', { location: [1, 2, 3], rotation: c.rotation, scale: c.scale });
      const world = doc.worldMatrix(id);
      // a parent that only moves: the rotation and scale stay as stored
      const writes = objectWrites(doc, () => doc.setParent(id, get('P').id, true));
      expect(get('A').rotation_euler).toEqual(c.rotation);
      expect(get('A').scale).toEqual(c.scale);
      expect(get('A').location).toEqual([-4, 2, 3]);
      expect(writes).toEqual({ A: ['location', 'parent'] });
      doc.setParent(id, null, true);
      expect(get('A').rotation_euler).toEqual(c.rotation);
      expect(get('A').scale).toEqual(c.scale);
      expect(get('A').location).toEqual([1, 2, 3]);
      // a turned parent: the object keeps its scale and its world matrix
      doc.setParent(id, get('T').id, true);
      expect(get('A').scale).toEqual(c.scale);
      expectMatrix(doc.worldMatrix(id), world, c.name);
    });

  it('the rotation relative to a turned parent is the one closest to the stored rotation', () => {
    const { doc, add, get } = setup();
    add('T', { rotation: [0, 0, 90 * deg] });
    const id = add('A', { location: [1, 2, 3], rotation: [190 * deg, 0, 0] });
    doc.setParent(id, get('T').id, true);
    expectDegrees(get('A').rotation_euler, [190, 0, -90], 'under T');
  });

  // docs/features.md names this exception: armatureParentSet and clearBoneParent
  // (operators/armature.ts) store what decompose4 reads from the new matrix, not through these rules
  /** A cube with the given rotation and scale parented to an armature at the origin, unturned. */
  function parentedToArmature(type: string, rotation: Vec3, scale: Vec3) {
    const t = setup();
    t.run('object.armature_add', { location: [0, 0, 0] });
    const arm = t.ctx.state.activeId!;
    t.run('mesh.primitive_cube_add', { location: [1, 2, 3] });
    const cube = t.get('Cube').id;
    t.doc.updateObject(cube, { rotation_euler: rotation, scale });
    const world = t.doc.worldMatrix(cube);
    t.ctx.state.selectedIds = [cube, arm];
    t.ctx.state.activeId = arm;
    const writes = objectWrites(t.doc, () => t.run('object.parent_set', { type }));
    return { ...t, cube, world, writes };
  }

  const ARMATURE_CASES: { rotation: Vec3; scale: Vec3; stored: Vec3; storedScale: Vec3 }[] = [
    { rotation: [0, 120 * deg, 0], scale: [1, 1, 1], stored: [180, 60, 180], storedScale: [1, 1, 1] },
    { rotation: [190 * deg, 0, 0], scale: [1, 1, 1], stored: [-170, 0, 0], storedScale: [1, 1, 1] },
    { rotation: [0, 0, 0], scale: [1, -1, 1], stored: [0, 0, -180], storedScale: [-1, 1, 1] },
  ];
  for (const c of ARMATURE_CASES)
    it(`Armature Deform parenting stores the channels a matrix decomposition gives: ${c.stored.join(', ')}`, () => {
      // the matrix relative to the armature is the cube's own, written again as other values
      const t = parentedToArmature('ARMATURE', c.rotation, c.scale);
      expect(t.writes.Cube).toEqual(expect.arrayContaining(['location', 'rotation_euler', 'scale']));
      expectDegrees(t.get('Cube').rotation_euler, c.stored, 'Cube');
      t.get('Cube').scale.forEach((v, i) => expect(v).toBeCloseTo(c.storedScale[i], 12));
      expectMatrix(t.doc.worldMatrix(t.cube), t.world, 'Cube');
      // parenting to the armature as an object keeps them
      const o = parentedToArmature('OBJECT', c.rotation, c.scale);
      expect(o.get('Cube').rotation_euler).toEqual(c.rotation);
      expect(o.get('Cube').scale).toEqual(c.scale);
    });

  it('clearing a Bone parent with Keep Transform stores the channels a matrix decomposition gives', () => {
    const t = parentedToArmature('BONE', [0, 120 * deg, 0], [1, 1, 1]);
    t.ctx.state.selectedIds = [t.cube];
    t.ctx.state.activeId = t.cube;
    t.run('object.parent_clear', { type: 'CLEAR_KEEP_TRANSFORM' });
    expect(t.get('Cube').parent).toBeNull();
    // Y 120° comes back as X ±180°, Y 60°, Z ±180°
    const [x, y, z] = t.get('Cube').rotation_euler.map((v) => v / deg);
    [Math.abs(x), y, Math.abs(z)].forEach((v, i) => expect(v).toBeCloseTo([180, 60, 180][i], 9));
    expectMatrix(t.doc.worldMatrix(t.cube), t.world, 'Cube');
  });
});

describe('operators that set world matrices keep what they leave unchanged', () => {
  it('Set Origin writes only the locations of the object and its children', () => {
    const { doc, ctx, run, add, get, select } = setup();
    run('mesh.primitive_cube_add', { location: [1, 2, 3] });
    const cube = get('Cube').id;
    doc.updateObject(cube, { rotation_euler: [0, 120 * deg, 0], scale: [1, -1, 2] });
    add('C', { location: [1, 0, 0], rotation: [190 * deg, 0, 0], scale: [1, -1, 1], parent: 'Cube' });
    const before = { cube: doc.worldMatrix(cube), child: doc.worldMatrix(get('C').id) };
    ctx.state.cursorLocation = [0.5, -1, 4];
    select('Cube');
    const writes = objectWrites(doc, () => run('object.origin_set', { type: 'ORIGIN_CURSOR' }));
    expect(get('Cube').rotation_euler).toEqual([0, 120 * deg, 0]);
    expect(get('Cube').scale).toEqual([1, -1, 2]);
    expect(get('C').rotation_euler).toEqual([190 * deg, 0, 0]);
    expect(get('C').scale).toEqual([1, -1, 1]);
    expect(writes).toEqual({ Cube: ['location'], C: ['location'] });
    const moved = before.cube.slice();
    [moved[12], moved[13], moved[14]] = [0.5, -1, 4];
    expectMatrix(doc.worldMatrix(cube), moved, 'Cube');
    expectMatrix(doc.worldMatrix(get('C').id), before.child, 'C');
  });

  it('Apply Transform writes only the channels it applies, and only when they change', () => {
    const cases: { name: string; rotation: Vec3; scale: Vec3; writes: Record<string, string[]> }[] = [
      {
        name: 'rotated and scaled',
        rotation: [0, 0, 30 * deg],
        scale: [2, 2, 2],
        writes: { Cube: ['rotation_euler', 'scale'] },
      },
      { name: 'scaled only', rotation: [0, 0, 0], scale: [2, 2, 2], writes: { Cube: ['scale'] } },
      { name: 'neither', rotation: [0, 0, 0], scale: [1, 1, 1], writes: {} },
    ];
    for (const c of cases) {
      const { doc, run, get, select } = setup();
      run('mesh.primitive_cube_add', { location: [1, 2, 3], rotation: c.rotation, scale: c.scale });
      select('Cube');
      const mesh = doc.encodeState();
      const writes = objectWrites(doc, () => run('object.transform_apply', { rotation: true, scale: true }));
      expect(get('Cube').location, c.name).toEqual([1, 2, 3]);
      expect(get('Cube').rotation_euler, c.name).toEqual([0, 0, 0]);
      expect(get('Cube').scale, c.name).toEqual([1, 1, 1]);
      expect(writes, c.name).toEqual(c.writes);
      // with nothing to apply, the mesh is not stored again either
      if (!Object.keys(c.writes).length) expect(doc.encodeState(), c.name).toEqual(mesh);
    }
  });

  it('Apply Transform keeps the children where they were, with continuous rotations', () => {
    const { doc, run, add, get, select } = setup();
    run('mesh.primitive_cube_add', { location: [1, 0, 0], rotation: [0, 0, 30 * deg] });
    add('C', { location: [0, 0, 0], rotation: [190 * deg, 0, 0], scale: [1, -1, 1], parent: 'Cube' });
    const child = doc.worldMatrix(get('C').id);
    select('Cube');
    const writes = objectWrites(doc, () => run('object.transform_apply', { rotation: true, scale: true }));
    expectDegrees(get('C').rotation_euler, [190, 0, 30], 'C');
    expect(get('C').scale).toEqual([1, -1, 1]);
    expect(writes.C).toEqual(['rotation_euler']);
    expectMatrix(doc.worldMatrix(get('C').id), child, 'C');
  });

  for (const c of CASES)
    it(`Duplicate with an offset keeps the rotation and scale of the copy: ${c.name}`, () => {
      const { run, get } = setup();
      run('mesh.primitive_cube_add', { name: 'A' });
      run('object.transform_set', { objects: ['A'], rotation_euler: c.rotation, scale: c.scale });
      run('object.duplicate', { offset: [2, 0, 0] });
      expect(get('A.001').rotation_euler).toEqual(c.rotation);
      expect(get('A.001').scale).toEqual(c.scale);
      expect(get('A.001').location).toEqual([2, 0, 0]);
    });

  it('a new orientation (a camera aligned to the view) takes the euler closest to the stored one', () => {
    const { doc, add, get } = setup();
    const id = add('Cam', { location: [1, 2, 3], rotation: [60 * deg, 0, 350 * deg], scale: [2, 2, 2] });
    doc.setWorldMatrix(id, compose4([4, 5, 6], [70 * deg, 0, 10 * deg], [1, 1, 1]));
    expectDegrees(get('Cam').rotation_euler, [70, 0, 370], 'Cam');
    get('Cam').scale.forEach((v) => expect(v).toBeCloseTo(1, 12));
    expect(get('Cam').location).toEqual([4, 5, 6]);
  });
});
