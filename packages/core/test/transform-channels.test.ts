import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  SceneDoc,
  axisAngle4,
  compose4,
  createEditorState,
  createOperatorRegistry,
  evaluateFCurve,
  fcurveKey,
  invert4,
  multiply4,
  normalize3,
  rotationFromEuler,
  transpose4,
  type Mat4,
  type OperatorContext,
  type Vec3,
} from '../src';
import { matrixFromAxes, matrixToCompatibleEuler } from '../src/constraints/math';

/*
 * Move, Rotate and Scale change an object's channels (location, rotation_euler, scale) as Blender's
 * do (SceneDoc.transformObject); the other operators that give objects new world matrices write
 * only the channels the new matrix changes (SceneDoc.setWorldMatrix). Both keep the channels they
 * leave as they were bit for bit, and store rotations as the euler closest to the stored one.
 * transform-blender.test.ts compares Rotate and Scale with a port of Blender's code.
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
        // a child with a scale of 0 turns as Blender turns it, which is not exactly this (see
        // transform-blender.test.ts)
        if (name === 'A' || c.scale.every((v) => v !== 0))
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
  for (const scale of [
    [1000, 0.01, 1],
    [1e4, 1e-3, 1],
  ] as Vec3[])
    it(`a rotation by 180° about an axis of a parent scaled ${scale.join(', ')} turns the child exactly`, () => {
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

  it('a rotation keeps the scale and stores Blender’s rotation: the turn in the parent’s space applied to the stored one', () => {
    const { doc, run, add, get, select } = setup();
    add('P', { scale: [2, 1, 1] });
    add('C', { location: [1, 0, 0], rotation: [0, 0, 30 * deg], parent: 'P' });
    const before = doc.worldMatrix(get('C').id);
    select('C');
    const writes = objectWrites(doc, () => run('transform.rotate', { value: 45 * deg, orient_axis: 'Z' }));
    expect(writes).toEqual({ C: ['rotation_euler'] });
    expect(get('C').scale).toEqual([1, 1, 1]);
    // Blender's ElementRotation: the euler of smtx · R · mtx · R(stored) = P⁻¹ · R · P · R(stored),
    // its axes normalized
    const P = compose4([0, 0, 0], [0, 0, 0], [2, 1, 1]);
    const turn = rotationFromEuler([0, 0, 45 * deg]);
    const fmat = multiply4(invert4(P), multiply4(turn, multiply4(P, rotationFromEuler([0, 0, 30 * deg]))));
    const blender = matrixToCompatibleEuler(fmat, [0, 0, 30 * deg]);
    expectDegrees(get('C').rotation_euler, blender.map((v) => v / deg) as Vec3, 'C');
    expect(get('C').rotation_euler[2] / deg).toBeCloseTo(74.571, 3);
    // the child's X axis turns by 45° in the world; the other axes do not (the child is sheared
    // under its parent and deforms as it turns, as in Blender)
    const after = doc.worldMatrix(get('C').id);
    const axis = (m: Mat4, c: number) => {
      const v = [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
      const l = Math.hypot(...v);
      return v.map((x) => x / l);
    };
    const x = axis(multiply4(turn, before), 0);
    axis(after, 0).forEach((v, i) => expect(v, `X axis[${i}]`).toBeCloseTo(x[i], 12));
    const y = axis(multiply4(turn, before), 1);
    const cos = axis(after, 1).reduce((sum, v, i) => sum + v * y[i], 0);
    expect(Math.acos(cos) / deg, 'Y axis off its turned direction').toBeGreaterThan(10);
  });

  it('eight rotations by 45° bring the child of a parent scaled [2, 1, 1] back where it started', () => {
    for (const z of [0, 30]) {
      const { doc, run, add, get, select } = setup();
      add('P', { scale: [2, 1, 1] });
      add('C', { location: [1, 0, 0], rotation: [0, 0, z * deg], parent: 'P' });
      const start = doc.worldMatrix(get('C').id);
      select('C');
      const writes = objectWrites(doc, () => {
        for (let i = 0; i < 8; i++) run('transform.rotate', { value: 45 * deg, orient_axis: 'Z' });
      });
      // the scale is never written (it grew to [1, 6.5, 1] when rotations rescaled the child)
      expect(writes, `Z ${z}°`).toEqual({ C: ['rotation_euler'] });
      expect(get('C').scale, `Z ${z}°`).toEqual([1, 1, 1]);
      expectDegrees(get('C').rotation_euler, [0, 0, z + 360], `Z ${z}°`);
      expectMatrix(doc.worldMatrix(get('C').id), start, `Z ${z}°`);
    }
  });
});

describe('a new world matrix with factors −1 along two of the object’s axes is stored as a rotation by 180° about the third', () => {
  // SceneDoc.setWorldMatrix (parenting with Keep Transform, Set Origin, …) keeps the stored scale
  // signs: such a matrix needs no mirroring (Blender's Scale, which transform.resize follows, negates
  // the two scales instead: see transform-blender.test.ts)
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
});

describe('a rotation stores the euler angles closest to the stored ones', () => {
  const cases: { name: string; rotation: Vec3; axis: 'X' | 'Y' | 'Z'; by: number; expected: Vec3 }[] = [
    { name: '170° + 20°', rotation: [170 * deg, 0, 0], axis: 'X', by: 20, expected: [190, 0, 0] },
    { name: '-170° - 20°', rotation: [-170 * deg, 0, 0], axis: 'X', by: -20, expected: [-190, 0, 0] },
    { name: '720° + 10°', rotation: [720 * deg, 0, 0], axis: 'X', by: 10, expected: [730, 0, 0] },
    { name: '730° + 10°', rotation: [730 * deg, 0, 0], axis: 'X', by: 10, expected: [740, 0, 0] },
    { name: 'Z 350° + 20°', rotation: [0, 0, 350 * deg], axis: 'Z', by: 20, expected: [0, 0, 370] },
    { name: 'Y 120°, Z + 10°', rotation: [0, 120 * deg, 0], axis: 'Z', by: 10, expected: [0, 120, 10] },
    // Blender 3.6 and later move an angle by a whole turn when it is more than 180° away (3.5 and
    // earlier only beyond 5.1 radians, which gave Y −133.73° here)
    {
      name: 'Y 51.68° + 170°',
      rotation: [138.52 * deg, 51.68 * deg, -62.33 * deg],
      axis: 'Y',
      by: 170,
      expected: [151.375224767, 226.272928766, 52.603188609],
    },
    // in exact gimbal lock only X − Z (Y = 90°) or X + Z (Y = −90°) is defined: Z is set to 0, as
    // Blender does
    {
      name: 'gimbal lock, Z + 10°',
      rotation: [10 * deg, 90 * deg, 30 * deg],
      axis: 'Z',
      by: 10,
      expected: [-30, 90, 0],
    },
    {
      name: 'gimbal lock at -90°, Z + 10°',
      rotation: [10 * deg, -90 * deg, 30 * deg],
      axis: 'Z',
      by: 10,
      expected: [50, -90, 0],
    },
    // near it the angles are read from the matrix as precisely as it allows: the euler of the
    // turned matrix (Blender treats Y within 0.00215° of 90° as gimbal lock and stores
    // [−20°, 89.999°, 0], which is 2.2e-5 off this matrix)
    {
      name: 'near gimbal lock, X + 0.001°',
      rotation: [10 * deg, 90 * deg, 30 * deg],
      axis: 'X',
      by: 0.001,
      expected: [70, 89.999, 90],
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
      const after = doc.worldMatrix(get('A').id);
      const expected = turned(rot, before);
      after.forEach((v, i) =>
        expect(Math.abs(v - expected[i]), `${c.name}: matrix[${i}]`).toBeLessThan(1e-12),
      );
    });

  it('near gimbal lock a turn about any axis stores the angles as precisely as the turned matrix allows', () => {
    // the turned matrix's entries that shrink with the cosine of Y carry the rounding of the turn's
    // product; Blender's formulas read X and Z from them (up to about 1e-16 / cos off), the stored
    // angles take X − Z (Y near 90°) or X + Z (near −90°) from the entries that keep their size
    const start: Vec3 = [40 * deg, 20 * deg, 70 * deg];
    for (const cos of [1e-11, 1e-8, 2e-6])
      for (const sign of [1, -1]) {
        const what = `cos Y ${cos}, Y near ${sign * 90}°`;
        const { run, add, get, select } = setup();
        add('A', { location: [1, 2, 3], rotation: start });
        select('A');
        // the turn from the start to [10°, ±(90° − cos), 30°] as an angle about an axis
        const r = multiply4(
          rotationFromEuler([10 * deg, sign * (Math.PI / 2 - cos), 30 * deg]),
          transpose4(rotationFromEuler(start)),
        );
        const angle = Math.acos((r[0] + r[5] + r[10] - 1) / 2);
        const axis: Vec3 = [r[6] - r[9], r[8] - r[2], r[1] - r[4]];
        run('transform.rotate', { value: angle, axis });
        // the matrix the object was turned to (transform.rotate normalizes the axis)
        const turned = multiply4(axisAngle4(normalize3(axis), angle), rotationFromEuler(start));
        expect(Math.hypot(turned[0], turned[1]) / cos, what).toBeCloseTo(1, 3);
        const stored = rotationFromEuler(get('A').rotation_euler);
        for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10])
          expect(Math.abs(stored[k] - turned[k]), `${what}: matrix[${k}]`).toBeLessThan(1e-13);
      }
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

  /** A cube with the given rotation and scale parented to an armature at the origin. */
  function parentedToArmature(type: string, rotation: Vec3, scale: Vec3, armature: Vec3 = [0, 0, 0]) {
    const t = setup();
    t.run('object.armature_add', { location: [0, 0, 0] });
    const arm = t.ctx.state.activeId!;
    t.doc.updateObject(arm, { rotation_euler: armature });
    t.run('mesh.primitive_cube_add', { location: [1, 2, 3] });
    const cube = t.get('Cube').id;
    t.doc.updateObject(cube, { rotation_euler: rotation, scale });
    const world = t.doc.worldMatrix(cube);
    t.ctx.state.selectedIds = [cube, arm];
    t.ctx.state.activeId = arm;
    const writes = objectWrites(t.doc, () => t.run('object.parent_set', { type }));
    return { ...t, cube, world, writes };
  }

  // rotations and scales a matrix decomposition used to give back as other values
  const ARMATURE_CASES: { rotation: Vec3; scale: Vec3; turned: Vec3 }[] = [
    { rotation: [0, 120 * deg, 0], scale: [1, 1, 1], turned: [0, 120, -90] },
    { rotation: [190 * deg, 0, 0], scale: [1, 1, 1], turned: [190, 0, -90] },
    { rotation: [0, 0, 0], scale: [1, -1, 1], turned: [0, 0, -90] },
  ];
  for (const c of ARMATURE_CASES)
    it(`Armature Deform parenting keeps what the armature leaves unchanged: ${c.rotation.map((v) => v / deg)}, ${c.scale}`, () => {
      // an armature at the origin, unturned, changes nothing: no channel is written
      const t = parentedToArmature('ARMATURE', c.rotation, c.scale);
      expect(t.writes.Cube).toEqual(['modifiers', 'parent', 'parent_bone', 'parent_type']);
      expect(t.get('Cube').rotation_euler).toEqual(c.rotation);
      expect(t.get('Cube').scale).toEqual(c.scale);
      // an armature turned by 90° about Z turns the rotation by −90° about Z, the closest euler to
      // the stored one, and keeps the scale and its signs
      const r = parentedToArmature('ARMATURE', c.rotation, c.scale, [0, 0, 90 * deg]);
      expect(r.writes.Cube).toEqual([
        'location',
        'modifiers',
        'parent',
        'parent_bone',
        'parent_type',
        'rotation_euler',
      ]);
      expectDegrees(r.get('Cube').rotation_euler, c.turned, 'turned armature');
      expect(r.get('Cube').scale).toEqual(c.scale);
      expectMatrix(r.doc.worldMatrix(r.cube), r.world, 'turned armature');
    });

  it('Bone parenting and clearing the Bone parent with Keep Transform write only what changes', () => {
    const t = parentedToArmature('BONE', [0, 120 * deg, 0], [1, -1, 1]);
    // the bone points along the armature's Z axis: relative to it the cube is turned, not scaled
    expect(t.writes.Cube).toEqual(['location', 'parent', 'parent_bone', 'parent_type', 'rotation_euler']);
    expect(t.get('Cube').scale).toEqual([1, -1, 1]);
    t.ctx.state.selectedIds = [t.cube];
    t.ctx.state.activeId = t.cube;
    const writes = objectWrites(t.doc, () => t.run('object.parent_clear', { type: 'CLEAR_KEEP_TRANSFORM' }));
    expect(t.get('Cube').parent).toBeNull();
    expect(writes.Cube).toEqual(['location', 'parent', 'parent_bone', 'parent_type', 'rotation_euler']);
    // back to Y 120° (the euler closest to the one relative to the bone), with the scale as it was
    expectDegrees(t.get('Cube').rotation_euler, [0, 120, 0], 'Cube');
    expect(t.get('Cube').scale).toEqual([1, -1, 1]);
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

describe('a new world matrix with axes scaled to 0 keeps a right-handed rotation', () => {
  // SceneDoc.setWorldMatrix (rotationAxes in scene-doc.ts): the rotation of an axis scaled to 0 is lost
  const stored: Vec3 = [10 * deg, 20 * deg, 30 * deg];
  const axis = (m: Mat4, c: number): Vec3 => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
  const unit = (v: Vec3): Vec3 => {
    const l = Math.hypot(...v);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];

  it('two axes scaled to 0: the third keeps its new direction, the next is the stored one made perpendicular to it', () => {
    const { doc, add, get } = setup();
    const id = add('A', { location: [1, 2, 3], rotation: stored });
    const x = unit([0.2, 0.6, 0.8]);
    const world: Mat4 = [...x.map((v) => v * 2), 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 1];
    const writes = objectWrites(doc, () => doc.setWorldMatrix(id, world));
    expect(writes).toEqual({ A: ['rotation_euler', 'scale'] });
    get('A').scale.forEach((v, i) => expect(v).toBeCloseTo([2, 0, 0][i], 12));
    const oldY = axis(rotationFromEuler(stored), 1);
    const along = oldY[0] * x[0] + oldY[1] * x[1] + oldY[2] * x[2];
    const y = unit([oldY[0] - x[0] * along, oldY[1] - x[1] * along, oldY[2] - x[2] * along]);
    expectMatrix(rotationFromEuler(get('A').rotation_euler), matrixFromAxes(x, y, cross(x, y)), 'A');
  });

  it('three axes scaled to 0 keep the stored rotation', () => {
    const { doc, add, get } = setup();
    const id = add('A', { location: [1, 2, 3], rotation: stored, scale: [1, -1, 1] });
    const world: Mat4 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 1];
    const writes = objectWrites(doc, () => doc.setWorldMatrix(id, world));
    expect(writes).toEqual({ A: ['scale'] });
    expect(get('A').rotation_euler).toEqual(stored);
    expect(get('A').scale.map(Math.abs)).toEqual([0, 0, 0]);
  });

  it('one axis scaled to 0 and the other two parallel: the first of those keeps its direction', () => {
    const { doc, add, get } = setup();
    const id = add('A', { location: [1, 2, 3], rotation: stored });
    const y = axis(rotationFromEuler(stored), 1);
    const world: Mat4 = [0, 0, 0, 0, ...y.map((v) => v * 1.5), 0, ...y.map((v) => v * 2), 0, 1, 2, 3, 1];
    const writes = objectWrites(doc, () => doc.setWorldMatrix(id, world));
    // the Y axis keeps the stored direction, so the rotation stays as stored
    expect(writes).toEqual({ A: ['scale'] });
    expect(get('A').rotation_euler).toEqual(stored);
    get('A').scale.forEach((v, i) => expect(v).toBeCloseTo([0, 1.5, 2][i], 12));
  });
});

describe('the tolerance within which recomputed channels count as unchanged grows with the parent’s axis ratio', () => {
  // the parent's inverse amplifies rounding by about the ratio of its longest to its shortest axis
  for (const scale of [
    [1000, 0.01, 1],
    [1e4, 1e-3, 1],
  ] as Vec3[])
    it(`a new world matrix turned by 180° about an axis of a parent scaled ${scale.join(', ')} writes only the rotation`, () => {
      const { doc, add, get } = setup();
      add('P', { location: [1, 2, 3], rotation: [0, 0, 25 * deg], scale });
      const id = add('C', {
        location: [0.3, 0.2, 0.1],
        rotation: [10 * deg, 20 * deg, 30 * deg],
        scale: [1.5, 0.5, 2],
        parent: 'P',
      });
      // the parent's Z axis is the world's: the turn changes only the child's rotation, and its
      // scale comes back from the parent's inverse up to 1.0e-11 off ([1000, 0.01, 1])
      const writes = objectWrites(doc, () =>
        doc.setWorldMatrix(id, turned([0, 0, Math.PI], doc.worldMatrix(id))),
      );
      expect(writes).toEqual({ C: ['rotation_euler'] });
      expect(get('C').scale).toEqual([1.5, 0.5, 2]);
    });
});

describe('Look At, and Drop to Ground and Snap to Surface with Align to Normal, write only what they change', () => {
  it('Look At turns a child of a rotated, unevenly scaled parent, keeps its scale, and writes nothing when run again', () => {
    const { doc, ctx, run, add, get } = setup();
    add('P', { location: [1, 2, 3], rotation: [20 * deg, 30 * deg, 40 * deg], scale: [2, 0.5, 1.5] });
    add('C', {
      location: [1, 0, 0],
      rotation: [10 * deg, 20 * deg, 30 * deg],
      scale: [1, 2, -3],
      parent: 'P',
    });
    add('T', { location: [5, -4, 7] });
    ctx.state.selectedIds = [get('C').id];
    ctx.state.activeId = get('C').id;
    const first = objectWrites(doc, () => run('object.look_at', { objects: ['C'], target: 'T' }));
    expect(first).toEqual({ C: ['rotation_euler'] });
    expect(get('C').scale).toEqual([1, 2, -3]);
    expect(get('C').location).toEqual([1, 0, 0]);
    // its −Z axis points at the target
    const w = doc.worldMatrix(get('C').id);
    const dir = [5 - w[12], -4 - w[13], 7 - w[14]];
    const z = [-w[8], -w[9], -w[10]];
    const cos = (dir[0] * z[0] + dir[1] * z[1] + dir[2] * z[2]) / (Math.hypot(...dir) * Math.hypot(...z));
    expect(cos).toBeCloseTo(1, 12);
    for (let i = 0; i < 2; i++)
      expect(objectWrites(doc, () => run('object.look_at', { objects: ['C'], target: 'T' }))).toEqual({});
  });

  for (const op of ['object.drop_to_ground', 'object.snap_to_surface'])
    it(`${op} with Align to Normal turns the object as Rotate does and writes nothing when run again`, () => {
      const { doc, ctx, run, get } = setup();
      run('mesh.primitive_plane_add', { size: 10, rotation: [10 * deg, 5 * deg, 0] });
      run('mesh.primitive_cube_add', { location: [0.5, 0.25, 3], rotation: [0.1, 0.2, 0.3] });
      const cube = get('Cube').id;
      doc.updateObject(cube, { scale: [1.5, 0.75, -2] });
      ctx.state.selectedIds = [cube];
      ctx.state.activeId = cube;
      const params =
        op === 'object.drop_to_ground'
          ? { objects: ['Cube'], align_to_normal: true }
          : { objects: ['Cube'], ray_origin: [0.5, 0.25, 10], align_to_normal: true };
      expect(objectWrites(doc, () => run(op, params))).toEqual({ Cube: ['location', 'rotation_euler'] });
      expect(get('Cube').scale).toEqual([1.5, 0.75, -2]);
      // the Z axis of its world matrix (negative scale included) follows the plane's normal
      const n = axisOf(doc.worldMatrix(get('Plane').id), 2);
      axisOf(doc.worldMatrix(cube), 2).forEach((v, i) => expect(v).toBeCloseTo(n[i], 12));
      for (let i = 0; i < 2; i++)
        expect(
          objectWrites(doc, () => run(op, params)),
          `run ${i + 2}`,
        ).toEqual({});
    });

  for (const op of ['object.drop_to_ground', 'object.snap_to_surface'])
    it(`${op} with Align to Normal turns a child of a turned parent as Rotate does`, () => {
      // the turn is a world rotation, which Rotate takes into the parent's space
      const { doc, ctx, run, add, get } = setup();
      run('mesh.primitive_plane_add', { size: 10, rotation: [10 * deg, 5 * deg, 0] });
      add('P', {
        location: [0.5, -0.5, 2],
        rotation: [20 * deg, -35 * deg, 50 * deg],
        scale: [1.5, 1.5, 1.5],
      });
      run('mesh.primitive_cube_add', { location: [0, 0, 0] });
      const cube = get('Cube').id;
      doc.updateObject(cube, {
        parent: get('P').id,
        location: [0.2, 0.4, 0.6],
        rotation_euler: [0.1, 0.2, 0.3],
        scale: [0.5, 0.25, -0.75],
      });
      ctx.state.selectedIds = [cube];
      ctx.state.activeId = cube;
      const params =
        op === 'object.drop_to_ground'
          ? { objects: ['Cube'], align_to_normal: true }
          : { objects: ['Cube'], ray_origin: [0.5, 0.25, 10], align_to_normal: true };
      expect(objectWrites(doc, () => run(op, params))).toEqual({ Cube: ['location', 'rotation_euler'] });
      expect(get('Cube').scale).toEqual([0.5, 0.25, -0.75]);
      const n = axisOf(doc.worldMatrix(get('Plane').id), 2);
      axisOf(doc.worldMatrix(cube), 2).forEach((v, i) => expect(v).toBeCloseTo(n[i], 12));
      expect(
        objectWrites(doc, () => run(op, params)),
        'run 2',
      ).toEqual({});
    });
});

/** Unit direction of an axis of a matrix. */
function axisOf(m: Mat4, c: number): Vec3 {
  const v: Vec3 = [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
}
