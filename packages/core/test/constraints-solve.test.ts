import { describe, expect, it } from 'vitest';
import {
  compose4,
  decompose4,
  identity4,
  invert4,
  lookAt4,
  multiply4,
  rotationFromEuler,
  translation4,
  type Mat4,
  type Vec3,
} from '../src/math';
import {
  CONSTRAINT_TYPES,
  clampConstraintParams,
  constraintTargets,
  createConstraint,
  getConstraintTypeInfo,
  parseConstraintParams,
  solveConstraints,
  type ConstraintContext,
} from '../src/constraints';
import type { ConstraintData, ConstraintType } from '../src/doc/types';
import { eulerToMatrix } from '../src/constraints/math';
import type { ArmaturePose } from '../src/armature/types';
import type { CurvePath, CurveSample } from '../src/curve/path';
import { defaultCurve } from '../src/doc/defaults';

const DEG = Math.PI / 180;

function ctxWith(objects: Record<string, Mat4>, extra: Partial<ConstraintContext> = {}): ConstraintContext {
  return {
    frame: 1,
    parentMatrix: identity4(),
    getWorldMatrix: (id) => objects[id] ?? null,
    getBoneMatrix: () => null,
    getCurvePath: () => null,
    ...extra,
  };
}

function con(type: ConstraintType, params: Record<string, unknown> = {}, init: Partial<ConstraintData> = {}) {
  return createConstraint(type, { target: 'T', ...init, params });
}

function solve(c: ConstraintData | ConstraintData[], world: Mat4, ctx: ConstraintContext) {
  return solveConstraints(Array.isArray(c) ? c : [c], world, ctx);
}

const col = (m: Mat4, c: number): Vec3 => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
const loc = (m: Mat4): Vec3 => [m[12], m[13], m[14]];
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const unit = (v: Vec3): Vec3 => {
  const l = len(v);
  return [v[0] / l, v[1] / l, v[2] / l];
};

function expectVec(a: readonly number[], b: readonly number[], digits = 6) {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
}

/** Path along a polyline with exact arc-length sampling (stand-in for curve paths). */
function polylinePath(points: Vec3[], cyclic = false, extra: Partial<CurveSample> = {}): CurvePath {
  const pts = cyclic ? [...points, points[0]] : points;
  const cum = [0];
  for (let i = 1; i < pts.length; i++)
    cum.push(
      cum[i - 1] + len([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]]),
    );
  const total = cum[cum.length - 1];
  return {
    length: total,
    cyclic,
    sample(t: number): CurveSample {
      const u = cyclic ? t - Math.floor(t) : Math.min(1, Math.max(0, t));
      const d = u * total;
      let i = 0;
      while (i < pts.length - 2 && cum[i + 1] < d) i++;
      const f = (d - cum[i]) / (cum[i + 1] - cum[i]);
      const a = pts[i];
      const b = pts[i + 1];
      return {
        position: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f],
        tangent: unit([b[0] - a[0], b[1] - a[1], b[2] - a[2]]),
        tilt: 0,
        radius: 1,
        ...extra,
      };
    },
  };
}

function curveCtx(
  path: CurvePath,
  matrix: Mat4 = identity4(),
  curve: Partial<ReturnType<typeof defaultCurve>> = {},
) {
  const data = { ...defaultCurve('cd', 'Curve'), ...curve };
  return ctxWith(
    { T: matrix },
    { getCurvePath: (id) => (id === 'T' ? { path, matrix, curve: data } : null) },
  );
}

describe('constraint catalogue', () => {
  it('lists every constraint type with Blender labels, defaults and schemas', () => {
    const types = CONSTRAINT_TYPES.map((t) => t.type).sort();
    expect(types).toEqual(
      [
        'CHILD_OF',
        'CLAMP_TO',
        'COPY_LOCATION',
        'COPY_ROTATION',
        'COPY_SCALE',
        'COPY_TRANSFORMS',
        'DAMPED_TRACK',
        'FLOOR',
        'FOLLOW_PATH',
        'IK',
        'LIMIT_DISTANCE',
        'LIMIT_LOCATION',
        'LIMIT_ROTATION',
        'LIMIT_SCALE',
        'LOCKED_TRACK',
        'PIVOT',
        'TRACK_TO',
      ].sort(),
    );
    for (const t of CONSTRAINT_TYPES) {
      expect(t.label.length).toBeGreaterThan(2);
      expect(t.description.length).toBeGreaterThan(40);
      expect(() => t.schema.parse({})).not.toThrow();
    }
    expect(getConstraintTypeInfo('TRACK_TO')!.schema.parse({})).toMatchObject({
      track_axis: 'TRACK_NEGATIVE_Z',
      up_axis: 'UP_Y',
      use_target_z: false,
    });
    expect(getConstraintTypeInfo('DAMPED_TRACK')!.schema.parse({})).toMatchObject({ track_axis: 'TRACK_Y' });
    expect(getConstraintTypeInfo('LOCKED_TRACK')!.schema.parse({})).toMatchObject({
      track_axis: 'TRACK_Y',
      lock_axis: 'LOCK_Z',
    });
    expect(getConstraintTypeInfo('FOLLOW_PATH')!.schema.parse({})).toMatchObject({
      forward_axis: 'FORWARD_Y',
      up_axis: 'UP_Z',
      offset: 0,
    });
    expect(getConstraintTypeInfo('PIVOT')!.schema.parse({})).toMatchObject({ rotation_range: 'NX' });
    expect(createConstraint('COPY_SCALE')).toMatchObject({
      name: 'Copy Scale',
      influence: 1,
      mute: false,
      target: null,
      params: { power: 1, use_add: false },
    });
  });
});

describe('Track To', () => {
  it('aims a camera at its target with -Z and keeps world Z up (same as lookAt)', () => {
    const eye: Vec3 = [7, -6, 5];
    const cam = compose4(eye, [0.3, -0.2, 1.1], [1, 1, 1]);
    const ctx = ctxWith({ T: translation4([1, 2, 0.5]) });
    const res = solve(con('TRACK_TO'), cam, ctx);
    expect(res.errors).toEqual([]);
    const m = res.matrix;
    const toTarget = unit([1 - 7, 2 + 6, 0.5 - 5]);
    expectVec(
      unit(col(m, 2)).map((v) => -v),
      toTarget,
    );
    expect(col(m, 0)[2]).toBeCloseTo(0, 9); // horizon stays level
    expect(col(m, 1)[2]).toBeGreaterThan(0); // camera up points up
    expectVec(loc(m), eye);
    expectVec(m, invert4(lookAt4(eye, [1, 2, 0.5], [0, 0, 1])));
  });

  it('keeps the owner scale and supports other axes and use_target_z', () => {
    const owner = compose4([0, 0, 0], [0, 0, 0], [2, 3, 4]);
    const target = compose4([0, 5, 0], [0.4, 0, 0], [1, 1, 1]);
    const res = solve(
      con('TRACK_TO', { track_axis: 'TRACK_X', up_axis: 'UP_Z', use_target_z: true }),
      owner,
      ctxWith({ T: target }),
    );
    expect(res.errors).toEqual([]);
    const m = res.matrix;
    expectVec(unit(col(m, 0)), [0, 1, 0]);
    expect(len(col(m, 0))).toBeCloseTo(2);
    expect(len(col(m, 1))).toBeCloseTo(3);
    expect(len(col(m, 2))).toBeCloseTo(4);
    // up follows the target's tilted Z axis projected onto the plane perpendicular to +Y
    const tz = col(target, 2);
    const proj = unit([tz[0], 0, tz[2]]);
    expectVec(unit(col(m, 2)), proj);
  });

  it('rejects identical track and up axes', () => {
    const res = solve(
      con('TRACK_TO', { track_axis: 'TRACK_Y', up_axis: 'UP_Y' }),
      identity4(),
      ctxWith({ T: translation4([0, 0, 1]) }),
    );
    expect(res.errors[0].message).toMatch(/different axes/);
    expect(res.matrix).toEqual(identity4());
  });
});

describe('Damped Track and Locked Track', () => {
  it('turns the track axis onto the target with the smallest rotation', () => {
    const owner = compose4([1, 1, 1], [0, 0, 0], [1, 2, 1]);
    const res = solve(con('DAMPED_TRACK'), owner, ctxWith({ T: translation4([1, 1, 5]) }));
    const m = res.matrix;
    expectVec(unit(col(m, 1)), [0, 0, 1]);
    expect(len(col(m, 1))).toBeCloseTo(2);
    // smallest rotation (about X): the X axis is untouched
    expectVec(col(m, 0), [1, 0, 0]);
    expectVec(loc(m), [1, 1, 1]);
    // opposite direction still resolves (180° turn)
    const back = solve(con('DAMPED_TRACK'), identity4(), ctxWith({ T: translation4([0, -3, 0]) })).matrix;
    expectVec(unit(col(back, 1)), [0, -1, 0]);
  });

  it('rotates only around the locked axis', () => {
    const owner = identity4();
    const target = translation4([3, 3, 7]);
    const m = solve(
      con('LOCKED_TRACK', { track_axis: 'TRACK_Y', lock_axis: 'LOCK_Z' }),
      owner,
      ctxWith({ T: target }),
    ).matrix;
    expectVec(col(m, 2), [0, 0, 1]);
    expectVec(unit(col(m, 1)), unit([3, 3, 0]));
    expect(
      solve(
        con('LOCKED_TRACK', { track_axis: 'TRACK_Z', lock_axis: 'LOCK_Z' }),
        owner,
        ctxWith({ T: target }),
      ).errors,
    ).toHaveLength(1);
    // target straight along the locked axis: no change
    expectVec(solve(con('LOCKED_TRACK'), owner, ctxWith({ T: translation4([0, 0, 4]) })).matrix, owner);
  });
});

describe('Copy constraints', () => {
  const target = compose4([4, -2, 6], [0.3, 0.2, 0.9], [2, 3, 0.5]);

  it('copies location per axis with invert and offset', () => {
    const owner = compose4([1, 1, 1], [0, 0, 0.5], [1, 1, 1]);
    expectVec(loc(solve(con('COPY_LOCATION'), owner, ctxWith({ T: target })).matrix), [4, -2, 6]);
    const m = solve(
      con('COPY_LOCATION', { use_y: false, invert_z: true, use_offset: true }),
      owner,
      ctxWith({ T: target }),
    ).matrix;
    expectVec(loc(m), [5, 1, -5]);
    expectVec(col(m, 0), col(owner, 0)); // rotation untouched
  });

  it('copies rotation with mix modes', () => {
    const owner = compose4([1, 2, 3], [0, 0, 0.5], [2, 2, 2]);
    const ctx = ctxWith({ T: target });
    const replace = decompose4(solve(con('COPY_ROTATION'), owner, ctx).matrix);
    expectVec(replace.rotation, [0.3, 0.2, 0.9]);
    expectVec(replace.scale, [2, 2, 2]);
    expectVec(replace.location, [1, 2, 3]);
    const onlyZ = decompose4(solve(con('COPY_ROTATION', { use_x: false, use_y: false }), owner, ctx).matrix);
    expectVec(onlyZ.rotation, [0, 0, 0.9]);
    const inverted = decompose4(
      solve(con('COPY_ROTATION', { use_x: false, use_y: false, invert_z: true }), owner, ctx).matrix,
    );
    expectVec(inverted.rotation, [0, 0, -0.9]);
    const add = decompose4(
      solve(con('COPY_ROTATION', { mix_mode: 'ADD', use_x: false, use_y: false }), owner, ctx).matrix,
    );
    expectVec(add.rotation, [0, 0, 1.4]);
    const before = solve(con('COPY_ROTATION', { mix_mode: 'BEFORE' }), owner, ctx).matrix;
    expectVec(
      before.slice(0, 11),
      multiply4(rotationFromEuler([0.3, 0.2, 0.9]), compose4([0, 0, 0], [0, 0, 0.5], [2, 2, 2])).slice(0, 11),
    );
    const after = solve(con('COPY_ROTATION', { mix_mode: 'AFTER' }), owner, ctx).matrix;
    expectVec(
      after.slice(0, 11),
      multiply4(
        rotationFromEuler([0, 0, 0.5]),
        multiply4(rotationFromEuler([0.3, 0.2, 0.9]), compose4([0, 0, 0], [0, 0, 0], [2, 2, 2])),
      ).slice(0, 11),
    );
  });

  it('copies scale with power, offset, additive and uniform modes', () => {
    const owner = compose4([0, 0, 0], [0, 0, 0.3], [2, 1, 1]);
    const ctx = ctxWith({ T: target });
    expectVec(decompose4(solve(con('COPY_SCALE'), owner, ctx).matrix).scale, [2, 3, 0.5]);
    expectVec(
      decompose4(solve(con('COPY_SCALE', { power: 2, use_z: false }), owner, ctx).matrix).scale,
      [4, 9, 1],
    );
    expectVec(
      decompose4(solve(con('COPY_SCALE', { use_offset: true }), owner, ctx).matrix).scale,
      [4, 3, 0.5],
    );
    expectVec(
      decompose4(solve(con('COPY_SCALE', { use_offset: true, use_add: true }), owner, ctx).matrix).scale,
      [3, 3, 0.5],
    );
    const uniform = decompose4(solve(con('COPY_SCALE', { use_make_uniform: true }), owner, ctx).matrix).scale;
    expectVec(
      uniform,
      [3, 3, 3].map(() => Math.cbrt(3)),
    );
    // rotation untouched
    expect(decompose4(solve(con('COPY_SCALE'), owner, ctx).matrix).rotation[2]).toBeCloseTo(0.3);
  });

  it('copies whole transforms with every mix mode', () => {
    const owner = compose4([1, 0, 0], [0, 0, 0.5], [1, 2, 1]);
    const ctx = ctxWith({ T: target });
    expectVec(solve(con('COPY_TRANSFORMS'), owner, ctx).matrix, target);
    expectVec(
      solve(con('COPY_TRANSFORMS', { mix_mode: 'BEFORE_FULL' }), owner, ctx).matrix,
      multiply4(target, owner),
    );
    expectVec(
      solve(con('COPY_TRANSFORMS', { mix_mode: 'AFTER_FULL' }), owner, ctx).matrix,
      multiply4(owner, target),
    );
    const split = decompose4(solve(con('COPY_TRANSFORMS', { mix_mode: 'BEFORE_SPLIT' }), owner, ctx).matrix);
    expectVec(split.location, [5, -2, 6]);
    expectVec(split.scale, [2, 6, 0.5]);
    const aligned = solve(con('COPY_TRANSFORMS', { mix_mode: 'AFTER' }), owner, ctx).matrix;
    // location of the target is carried through the owner's full matrix
    expectVec(loc(aligned), loc(multiply4(owner, target)));
    expectVec(decompose4(aligned).scale, [2, 6, 0.5]);
  });
});

describe('Limit constraints', () => {
  it('clamps location, rotation and scale only on enabled axes', () => {
    const owner = compose4([5, -5, 2], [0.2, 1.2, -2], [3, 0.1, 1]);
    const ctx = ctxWith({});
    const l = solve(
      con(
        'LIMIT_LOCATION',
        { use_max_x: true, max_x: 1, use_min_y: true, min_y: -1, use_min_z: true, min_z: 0 },
        { target: null },
      ),
      owner,
      ctx,
    );
    expect(l.errors).toEqual([]);
    expectVec(loc(l.matrix), [1, -1, 2]);
    const r = decompose4(
      solve(
        con(
          'LIMIT_ROTATION',
          { use_limit_y: true, min_y: -0.5, max_y: 0.5, use_limit_z: true, min_z: -1, max_z: 1 },
          { target: null },
        ),
        owner,
        ctx,
      ).matrix,
    );
    expectVec(r.rotation, [0.2, 0.5, -1]);
    expectVec(r.scale, [3, 0.1, 1]);
    const s = decompose4(
      solve(
        con('LIMIT_SCALE', { use_max_x: true, max_x: 2, use_min_y: true, min_y: 0.5 }, { target: null }),
        owner,
        ctx,
      ).matrix,
    );
    expectVec(s.scale, [2, 0.5, 1]);
  });

  it('treats rotation limits as a range on the circle unless legacy behaviour is on', () => {
    const owner = compose4([0, 0, 0], [0, 0, 170 * DEG], [1, 1, 1]);
    const params = { use_limit_z: true, min_z: -10 * DEG, max_z: 90 * DEG };
    const modern = decompose4(
      solve(con('LIMIT_ROTATION', params, { target: null }), owner, ctxWith({})).matrix,
    );
    expect(modern.rotation[2]).toBeCloseTo(90 * DEG); // 170° is closer to 90° than to -10°
    const legacy = decompose4(
      solve(
        con('LIMIT_ROTATION', { ...params, use_legacy_behavior: true }, { target: null }),
        owner,
        ctxWith({}),
      ).matrix,
    );
    expect(legacy.rotation[2]).toBeCloseTo(90 * DEG);
    const wrapped = compose4([0, 0, 0], [0, 0, -100 * DEG], [1, 1, 1]);
    const range = { use_limit_z: true, min_z: 170 * DEG, max_z: 280 * DEG };
    // -100° == 260° lies inside [170°, 280°] on the circle: unchanged
    expect(
      decompose4(solve(con('LIMIT_ROTATION', range, { target: null }), wrapped, ctxWith({})).matrix)
        .rotation[2],
    ).toBeCloseTo(-100 * DEG);
    // legacy clamps the number -100° up to 170°
    expect(
      decompose4(
        solve(
          con('LIMIT_ROTATION', { ...range, use_legacy_behavior: true }, { target: null }),
          wrapped,
          ctxWith({}),
        ).matrix,
      ).rotation[2],
    ).toBeCloseTo(170 * DEG);
  });

  it('limits the distance to a target inside, outside and on the surface', () => {
    const ctx = ctxWith({ T: translation4([0, 0, 0]) });
    const far = translation4([10, 0, 0]);
    const near = translation4([1, 0, 0]);
    expectVec(loc(solve(con('LIMIT_DISTANCE', { distance: 4 }), far, ctx).matrix), [4, 0, 0]);
    expectVec(loc(solve(con('LIMIT_DISTANCE', { distance: 4 }), near, ctx).matrix), [1, 0, 0]);
    expectVec(
      loc(solve(con('LIMIT_DISTANCE', { distance: 4, limit_mode: 'LIMITDIST_OUTSIDE' }), near, ctx).matrix),
      [4, 0, 0],
    );
    expectVec(
      loc(solve(con('LIMIT_DISTANCE', { distance: 4, limit_mode: 'LIMITDIST_ONSURFACE' }), near, ctx).matrix),
      [4, 0, 0],
    );
    expectVec(
      loc(solve(con('LIMIT_DISTANCE', { distance: 4, limit_mode: 'LIMITDIST_ONSURFACE' }), far, ctx).matrix),
      [4, 0, 0],
    );
    // distance 0 = not initialised: keeps the current distance
    expectVec(loc(solve(con('LIMIT_DISTANCE'), far, ctx).matrix), [10, 0, 0]);
    // an owner exactly at the target has no direction and stays
    expectVec(
      loc(
        solve(con('LIMIT_DISTANCE', { distance: 2, limit_mode: 'LIMITDIST_OUTSIDE' }), identity4(), ctx)
          .matrix,
      ),
      [0, 0, 0],
    );
  });
});

describe('Child Of', () => {
  it('parents to the target and honours the inverse matrix and channels', () => {
    const parent = compose4([2, 0, 0], [0, 0, Math.PI / 2], [2, 2, 2]);
    const owner = translation4([1, 0, 0]);
    const ctx = ctxWith({ T: parent });
    const plain = solve(con('CHILD_OF'), owner, ctx).matrix;
    expectVec(plain, multiply4(parent, owner));
    const keep = solve(con('CHILD_OF', { inverse_matrix: invert4(parent) }), owner, ctx).matrix;
    expectVec(keep, owner);
    const locOnly = solve(
      con('CHILD_OF', {
        use_rotation_x: false,
        use_rotation_y: false,
        use_rotation_z: false,
        use_scale_x: false,
        use_scale_y: false,
        use_scale_z: false,
      }),
      owner,
      ctx,
    ).matrix;
    expectVec(locOnly, translation4([3, 0, 0]));
    const noX = solve(con('CHILD_OF', { use_location_x: false }), owner, ctx).matrix;
    expect(noX[12]).toBeCloseTo(1); // disabled location channel keeps the owner's own value
  });
});

describe('Floor and Pivot', () => {
  it('keeps the owner above the floor, with offset, negative axes and rotation', () => {
    const ctx = ctxWith({ T: translation4([0, 0, 1]) });
    expectVec(loc(solve(con('FLOOR'), translation4([3, 3, -2]), ctx).matrix), [3, 3, 1]);
    expectVec(loc(solve(con('FLOOR'), translation4([3, 3, 5]), ctx).matrix), [3, 3, 5]);
    expectVec(loc(solve(con('FLOOR', { offset: 0.5 }), translation4([0, 0, 1.2]), ctx).matrix), [0, 0, 1.5]);
    expectVec(
      loc(solve(con('FLOOR', { floor_location: 'FLOOR_NEGATIVE_Z' }), translation4([0, 0, 5]), ctx).matrix),
      [0, 0, 1],
    );
    // tilted floor: 90° around X turns the floor's Z into world -Y
    const tilted = ctxWith({ T: compose4([0, 0, 0], [Math.PI / 2, 0, 0], [1, 1, 1]) });
    expectVec(
      loc(solve(con('FLOOR', { use_rotation: true }), translation4([0, 2, 0]), tilted).matrix),
      [0, 0, 0],
    );
    expectVec(
      loc(solve(con('FLOOR', { use_rotation: true }), translation4([0, -2, 0]), tilted).matrix),
      [0, -2, 0],
    );
  });

  it('rotates around the pivot point within the rotation range', () => {
    const owner = compose4([0, 0, 0], [0, 0, Math.PI / 2], [1, 1, 1]);
    const ctx = ctxWith({ T: translation4([1, 0, 0]) });
    const m = solve(con('PIVOT', { rotation_range: 'ALWAYS_ACTIVE' }), owner, ctx).matrix;
    expectVec(loc(m), [1, -1, 0]);
    // no target: offset relative to the owner, or absolute
    expectVec(
      loc(
        solve(
          con('PIVOT', { offset: [1, 0, 0], rotation_range: 'ALWAYS_ACTIVE' }, { target: null }),
          owner,
          ctxWith({}),
        ).matrix,
      ),
      [1, -1, 0],
    );
    expectVec(
      loc(
        solve(
          con(
            'PIVOT',
            { offset: [0, 2, 0], use_relative_location: false, rotation_range: 'ALWAYS_ACTIVE' },
            { target: null },
          ),
          owner,
          ctxWith({}),
        ).matrix,
      ),
      [2, 2, 0],
    );
    // positive Z rotation: inactive for NZ, active for Z
    expectVec(loc(solve(con('PIVOT', { rotation_range: 'NZ' }), owner, ctx).matrix), [0, 0, 0]);
    expectVec(loc(solve(con('PIVOT', { rotation_range: 'Z' }), owner, ctx).matrix), [1, -1, 0]);
    // the default NX range is active while the X rotation is zero
    expectVec(loc(solve(con('PIVOT'), owner, ctx).matrix), [1, -1, 0]);
  });
});

describe('Follow Path and Clamp To', () => {
  const square: Vec3[] = [
    [0, 0, 0],
    [4, 0, 0],
    [4, 4, 0],
    [0, 4, 0],
  ];

  it('places the owner along the path from eval_time, offset and fixed offset_factor', () => {
    const path = polylinePath(square, true);
    const at = (curve: object, params: Record<string, unknown> = {}) =>
      loc(solve(con('FOLLOW_PATH', params), identity4(), curveCtx(path, identity4(), curve)).matrix);
    expectVec(at({ eval_time: 0 }), [0, 0, 0]);
    expectVec(at({ eval_time: 25 }), [4, 0, 0]);
    expectVec(at({ eval_time: 50 }), [4, 4, 0]);
    expectVec(at({ eval_time: 50, path_duration: 200 }), [4, 0, 0]);
    expectVec(at({ eval_time: 50 }, { offset: 25 }), [4, 0, 0]);
    expectVec(at({ eval_time: 125 }), [4, 0, 0]); // cyclic: wraps around
    expectVec(at({ eval_time: 0 }, { use_fixed_location: true, offset_factor: 0.375 }), [4, 2, 0]);
  });

  it('extrapolates open paths and follows the curve object transform', () => {
    const open = polylinePath([
      [0, 0, 0],
      [2, 0, 0],
    ]);
    const before = solve(
      con('FOLLOW_PATH'),
      identity4(),
      curveCtx(open, identity4(), { eval_time: -50 }),
    ).matrix;
    expectVec(loc(before), [-1, 0, 0]);
    const moved = compose4([0, 0, 3], [0, 0, Math.PI / 2], [2, 2, 2]);
    const m = solve(
      con('FOLLOW_PATH'),
      translation4([0, 0, 1]),
      curveCtx(open, moved, { eval_time: 50 }),
    ).matrix;
    // point (1,0,0) on the path → world (0,2,3); owner offset (0,0,1) is in path space (curve scale 2)
    expectVec(loc(m), [0, 2, 5]);
    expectVec([len(col(m, 0)), len(col(m, 1)), len(col(m, 2))], [1, 1, 1]); // owner keeps its scale
  });

  it('orients forward_axis along the path with use_curve_follow and scales with the radius', () => {
    const path = polylinePath(square, true, { radius: 0.5 });
    const ctx = curveCtx(path, identity4(), { eval_time: 37.5 }); // middle of the edge (4,0)→(4,4)
    const m = solve(con('FOLLOW_PATH', { use_curve_follow: true }), identity4(), ctx).matrix;
    expectVec(loc(m), [4, 2, 0]);
    expectVec(col(m, 1), [0, 1, 0]); // +Y along the tangent
    expectVec(col(m, 2), [0, 0, 1]); // +Z up
    expectVec(col(m, 0), [1, 0, 0]);
    const x = solve(
      con('FOLLOW_PATH', { use_curve_follow: true, forward_axis: 'TRACK_NEGATIVE_X', up_axis: 'UP_Z' }),
      identity4(),
      ctx,
    ).matrix;
    expectVec(col(x, 0), [0, -1, 0]);
    expectVec(col(x, 2), [0, 0, 1]);
    const r = solve(con('FOLLOW_PATH', { use_curve_radius: true }), identity4(), ctx).matrix;
    expect(len(col(r, 0))).toBeCloseTo(0.5);
    expect(
      solve(con('FOLLOW_PATH', { forward_axis: 'FORWARD_Z', up_axis: 'UP_Z' }), identity4(), ctx).errors[0]
        .message,
    ).toMatch(/different axes/);
  });

  it('clamps the owner onto the curve along its main axis', () => {
    const line = polylinePath([
      [0, 0, 0],
      [10, 0, 0],
    ]);
    const ctx = curveCtx(line, identity4(), {
      splines: [
        {
          type: 'POLY',
          points: [
            {
              co: [0, 0, 0],
              handle_left: null,
              handle_right: null,
              handle_left_type: 'AUTO',
              handle_right_type: 'AUTO',
              radius: 1,
              tilt: 0,
              weight: 1,
            },
            {
              co: [10, 0, 0],
              handle_left: null,
              handle_right: null,
              handle_left_type: 'AUTO',
              handle_right_type: 'AUTO',
              radius: 1,
              tilt: 0,
              weight: 1,
            },
          ],
          use_cyclic_u: false,
          resolution_u: 0,
          order_u: 4,
          use_endpoint_u: true,
          use_smooth: true,
          material_index: 0,
        },
      ],
    });
    expectVec(loc(solve(con('CLAMP_TO'), translation4([3, 5, 2]), ctx).matrix), [3, 0, 0]);
    expectVec(loc(solve(con('CLAMP_TO'), translation4([-3, 5, 2]), ctx).matrix), [0, 0, 0]);
    expectVec(loc(solve(con('CLAMP_TO'), translation4([13, 0, 0]), ctx).matrix), [10, 0, 0]);
    expectVec(
      loc(solve(con('CLAMP_TO', { use_cyclic: true }), translation4([13, 0, 0]), ctx).matrix),
      [3, 0, 0],
    );
    // a flat axis maps everything at or beyond its single value to the end of the curve
    expectVec(
      loc(solve(con('CLAMP_TO', { main_axis: 'CLAMPTO_Y' }), translation4([3, 5, 2]), ctx).matrix),
      [10, 0, 0],
    );
    expectVec(
      loc(solve(con('CLAMP_TO', { main_axis: 'CLAMPTO_Y' }), translation4([3, -5, 2]), ctx).matrix),
      [0, 0, 0],
    );
  });

  it('requires a curve target', () => {
    const res = solve(con('FOLLOW_PATH'), identity4(), ctxWith({ T: identity4() }));
    expect(res.errors[0].message).toMatch(/curve|path/i);
  });
});

describe('stack evaluation', () => {
  it('blends by influence: location lerp, rotation slerp, scale lerp', () => {
    const owner = compose4([0, 0, 0], [0, 0, 0], [1, 1, 1]);
    const target = compose4([4, 0, 0], [0, 0, Math.PI / 2], [3, 3, 3]);
    const res = solve(con('COPY_TRANSFORMS', {}, { influence: 0.5 }), owner, ctxWith({ T: target }));
    const d = decompose4(res.matrix);
    expectVec(d.location, [2, 0, 0]);
    expectVec(d.rotation, [0, 0, Math.PI / 4]);
    expectVec(d.scale, [2, 2, 2]);
    // influence 0 and mute leave the matrix unchanged
    expectVec(
      solve(con('COPY_TRANSFORMS', {}, { influence: 0 }), owner, ctxWith({ T: target })).matrix,
      owner,
    );
    expectVec(solve(con('COPY_TRANSFORMS', {}, { mute: true }), owner, ctxWith({ T: target })).matrix, owner);
  });

  it('applies constraints in order', () => {
    const ctx = ctxWith({ T: translation4([5, 5, 5]) });
    const stack = [
      con('COPY_LOCATION'),
      con('LIMIT_LOCATION', { use_max_z: true, max_z: 1 }, { target: null }),
    ];
    expectVec(loc(solve(stack, identity4(), ctx).matrix), [5, 5, 1]);
    expectVec(loc(solve([stack[1], stack[0]], identity4(), ctx).matrix), [5, 5, 5]);
  });

  it('reports missing, unset, self and cyclic targets without changing the matrix', () => {
    const owner = translation4([1, 2, 3]);
    const info = (id: string) =>
      id === 'C' || id === 'self'
        ? {
            name: id === 'C' ? 'Cycle' : 'Me',
            type: 'EMPTY' as const,
            parentMatrix: null,
            basisMatrix: identity4(),
          }
        : null;
    const ctx = ctxWith({}, { ownerId: 'self', getObjectInfo: info });
    const results = [
      solve(con('COPY_LOCATION', {}, { target: null }), owner, ctx),
      solve(con('COPY_LOCATION', {}, { target: 'gone' }), owner, ctx),
      solve(con('COPY_LOCATION', {}, { target: 'self' }), owner, ctx),
      solve(con('COPY_LOCATION', {}, { target: 'C' }), owner, ctx),
    ];
    expect(results.map((r) => r.errors[0]?.message)).toEqual([
      'No target object set',
      "Target object 'gone' not found",
      'A constraint cannot use its own object as target',
      "Target 'Cycle' is part of a dependency cycle",
    ]);
    for (const r of results) expectVec(r.matrix, owner);
    // a failing constraint does not stop the rest of the stack
    const rest = solve(
      [
        con('COPY_LOCATION', {}, { target: 'gone' }),
        con('LIMIT_LOCATION', { use_max_x: true, max_x: 0 }, { target: null }),
      ],
      owner,
      ctx,
    );
    expect(rest.errors).toHaveLength(1);
    expectVec(loc(rest.matrix), [0, 2, 3]);
  });

  it('skips constraints the context reports on a dependency cycle without reading their target', () => {
    const reads: string[] = [];
    const message = "Target 'T' is part of a dependency cycle: O [Loop] → T [Copy Location] → O";
    const ctx = ctxWith(
      {},
      {
        getWorldMatrix: (id) => {
          reads.push(id);
          return id === 'T' ? translation4([5, 0, 0]) : null;
        },
        dependencyCycle: (c) => (c.name === 'Loop' ? message : null),
      },
    );
    const owner = translation4([1, 2, 3]);
    const looped = con('COPY_LOCATION', {}, { name: 'Loop' });
    const res = solve(
      [looped, con('LIMIT_LOCATION', { use_max_z: true, max_z: 0 }, { target: null })],
      owner,
      ctx,
    );
    expect(res.errors).toEqual([{ constraintId: looped.id, message }]);
    expect(reads).toEqual([]);
    expectVec(loc(res.matrix), [1, 2, 0]); // the rest of the stack still runs
    const fine = solve(con('COPY_LOCATION', {}, { name: 'Fine' }), owner, ctx);
    expect(fine.errors).toEqual([]);
    expect(reads).toEqual(['T']);
    // muted constraints and invalid parameters are reported (or skipped) before the cycle check
    expect(solve({ ...looped, mute: true }, owner, ctx).errors).toEqual([]);
    expect(solve({ ...looped, params: { use_x: 3 } }, owner, ctx).errors[0].message).toMatch(/^Invalid/);
  });

  it('clamps parameters outside their range, like Blender does for animated values', () => {
    expect(parseConstraintParams({ type: 'FOLLOW_PATH', params: { offset_factor: 1.7 } })).toMatchObject({
      ok: true,
      params: { offset_factor: 1 },
    });
    expect(parseConstraintParams({ type: 'COPY_LOCATION', params: { head_tail: -0.5 } })).toMatchObject({
      ok: true,
      params: { head_tail: 0 },
    });
    expect(parseConstraintParams({ type: 'LIMIT_DISTANCE', params: { distance: -3 } })).toMatchObject({
      ok: true,
      params: { distance: 0 },
    });
    // only numbers are clamped: other invalid values are still reported
    expect(parseConstraintParams({ type: 'FOLLOW_PATH', params: { offset_factor: 'end' } }).ok).toBe(false);
    expect(clampConstraintParams('FOLLOW_PATH', { offset_factor: -2, offset: -50, x: 'y' })).toEqual({
      offset_factor: 0,
      offset: -50,
      x: 'y',
    });
    expect(clampConstraintParams('NOPE', { a: 5 })).toEqual({ a: 5 });
    // an open path is not extrapolated past its end by an out-of-range offset_factor
    const path = polylinePath([
      [0, 0, 0],
      [4, 0, 0],
    ]);
    const res = solve(
      con('FOLLOW_PATH', { use_fixed_location: true, offset_factor: 1.7 }),
      identity4(),
      curveCtx(path),
    );
    expect(res.errors).toEqual([]);
    expectVec(loc(res.matrix), [4, 0, 0]);
  });

  it('survives garbage data', () => {
    const owner = translation4([1, 0, 0]);
    const ctx = ctxWith({ T: translation4([5, 0, 0]) });
    const bad = [
      null,
      42,
      { id: 'u', type: 'FLUFFY', influence: 1, params: {} },
      { ...con('COPY_LOCATION'), id: 'p', params: { use_x: 'yes' } },
      { ...con('COPY_LOCATION'), id: 'i', influence: Number.NaN },
      { ...con('COPY_SCALE', { power: -1 }), id: 'n' },
      { ...con('IK'), id: 'ik' },
      { ...con('COPY_LOCATION'), id: 'np', params: null },
    ] as unknown as ConstraintData[];
    const res = solveConstraints(bad, owner, ctx);
    expect(res.errors.map((e) => e.constraintId)).toEqual(['#0', '#1', 'u', 'p', 'i']);
    // power -1 of a unit target scale is fine; params: null falls back to defaults (copies location)
    expectVec(loc(res.matrix), [5, 0, 0]);
    expect(solveConstraints(null as unknown as ConstraintData[], owner, ctx).matrix).toEqual(owner);
    // zero-scale target with negative power produces an infinite scale: reported, matrix kept
    const zero = solveConstraints(
      [con('COPY_SCALE', { power: -1 })],
      owner,
      ctxWith({ T: compose4([0, 0, 0], [0, 0, 0], [0, 1, 1]) }),
    );
    expect(zero.errors[0].message).toMatch(/non-finite/);
    expectVec(zero.matrix, owner);
  });

  it('lists the objects a constraint reads', () => {
    expect(constraintTargets(con('TRACK_TO', {}, { target: 'A' }))).toEqual(['A']);
    expect(constraintTargets(con('IK', { pole_target: 'P' }, { target: 'A' }))).toEqual(['A', 'P']);
    expect(constraintTargets(con('LIMIT_LOCATION', {}, { target: null }))).toEqual([]);
    expect(constraintTargets(null as unknown as ConstraintData)).toEqual([]);
  });
});

describe('spaces and bone sub-targets', () => {
  it('evaluates LOCAL owner space relative to the parent', () => {
    const parent = compose4([10, 0, 0], [0, 0, Math.PI / 2], [1, 1, 1]);
    const owner = multiply4(parent, translation4([5, 0, 0]));
    const ctx = ctxWith({}, { parentMatrix: parent });
    const m = solve(
      con('LIMIT_LOCATION', { use_max_x: true, max_x: 2, owner_space: 'LOCAL' }, { target: null }),
      owner,
      ctx,
    ).matrix;
    expectVec(m, multiply4(parent, translation4([2, 0, 0])));
    const world = solve(
      con('LIMIT_LOCATION', { use_max_x: true, max_x: 2 }, { target: null }),
      owner,
      ctx,
    ).matrix;
    expectVec(loc(world), [2, 5, 0]);
  });

  it("uses Blender's local space for parentless owners and targets", () => {
    const basis = compose4([0, 3, 0], [0, 0, Math.PI / 2], [2, 2, 2]);
    const ctx = ctxWith(
      { T: compose4([1, 2, 3], [0, 0, Math.PI / 2], [1, 1, 1]) },
      {
        ownerId: 'O',
        getObjectInfo: (id) =>
          id === 'O'
            ? { name: 'Owner', type: 'EMPTY', parentMatrix: null, basisMatrix: basis }
            : id === 'T'
              ? {
                  name: 'Target',
                  type: 'EMPTY',
                  parentMatrix: null,
                  basisMatrix: compose4([1, 2, 3], [0, 0, Math.PI / 2], [1, 1, 1]),
                }
              : null,
      },
    );
    // owner local = its own rotation frame: location (0,3,0) reads as (3,0,0) along its rotated axes
    const m = solve(
      con('LIMIT_LOCATION', { use_max_x: true, max_x: 1, owner_space: 'LOCAL' }, { target: null }),
      basis,
      ctx,
    ).matrix;
    expectVec(loc(m), [0, 1, 0]);
    // a parentless target in LOCAL space: its location in its own rotated frame
    const c = solve(con('COPY_LOCATION', { target_space: 'LOCAL' }), translation4([0, 0, 0]), ctx).matrix;
    expectVec(loc(c), [2, -1, 3]);
  });

  it('targets armature bones (head/tail) through getBoneMatrix', () => {
    const bone = compose4([1, 0, 0], [0, 0, Math.PI / 2], [1, 1, 1]); // +Y of the bone points along world -X
    const ctx = ctxWith(
      { Arm: translation4([0, 0, 0]) },
      { getBoneMatrix: (a, b) => (a === 'Arm' && b === 'Hand' ? { matrix: bone, length: 2 } : null) },
    );
    const head = solve(
      con('COPY_LOCATION', {}, { target: 'Arm', subtarget: 'Hand' }),
      identity4(),
      ctx,
    ).matrix;
    expectVec(loc(head), [1, 0, 0]);
    const tail = solve(
      con('COPY_LOCATION', { head_tail: 1 }, { target: 'Arm', subtarget: 'Hand' }),
      identity4(),
      ctx,
    ).matrix;
    expectVec(loc(tail), [-1, 0, 0]);
    const rot = decompose4(
      solve(con('COPY_ROTATION', {}, { target: 'Arm', subtarget: 'Hand' }), identity4(), ctx).matrix,
    );
    expectVec(rot.rotation, [0, 0, Math.PI / 2]);
    const missing = solve(con('COPY_LOCATION', {}, { target: 'Arm', subtarget: 'Foot' }), identity4(), ctx);
    expect(missing.errors[0].message).toMatch(/Bone 'Foot' not found/);
    const track = solve(
      con('DAMPED_TRACK', { head_tail: 1 }, { target: 'Arm', subtarget: 'Hand' }),
      translation4([-1, -5, 0]),
      ctx,
    ).matrix;
    expectVec(unit(col(track, 1)), [0, 1, 0]);
  });
});

describe('edge cases', () => {
  it('handles a target sitting exactly at the owner', () => {
    const ctx = ctxWith({ T: identity4() });
    const tracked = solve(con('TRACK_TO'), identity4(), ctx);
    expect(tracked.errors).toEqual([]);
    expectVec(tracked.matrix, identity4()); // Blender's fallback frame, no NaN
    expectVec(solve(con('DAMPED_TRACK'), identity4(), ctx).matrix, identity4());
    expectVec(solve(con('LOCKED_TRACK'), identity4(), ctx).matrix, identity4());
    expectVec(solve(con('LIMIT_DISTANCE', { distance: 1 }), identity4(), ctx).matrix, identity4());
  });

  it('copies rotation in other euler orders and with the legacy OFFSET mode', () => {
    const target = eulerToMatrix([0.3, 0.2, 0.4], 'ZXY');
    const m = solve(
      con('COPY_ROTATION', { euler_order: 'ZXY', use_x: false }),
      identity4(),
      ctxWith({ T: target }),
    ).matrix;
    expectVec(m, eulerToMatrix([0, 0.2, 0.4], 'ZXY'));
    const owner = compose4([0, 0, 0], [0, 0, 0.5], [1, 1, 1]);
    const offset = solve(
      con('COPY_ROTATION', { mix_mode: 'OFFSET' }),
      owner,
      ctxWith({ T: compose4([0, 0, 0], [0, 0, 0.3], [1, 1, 1]) }),
    );
    expect(decompose4(offset.matrix).rotation[2]).toBeCloseTo(0.8);
  });

  it('limits rotation in other euler orders', () => {
    const owner = eulerToMatrix([0.5, 0.2, 0.1], 'YXZ');
    const m = solve(
      con(
        'LIMIT_ROTATION',
        { euler_order: 'YXZ', use_limit_x: true, min_x: -0.2, max_x: 0.2 },
        { target: null },
      ),
      owner,
      ctxWith({}),
    ).matrix;
    expectVec(m, eulerToMatrix([0.2, 0.2, 0.1], 'YXZ'));
  });

  it('tracks with negative axes and locked axes', () => {
    const m = solve(
      con('LOCKED_TRACK', { track_axis: 'TRACK_NEGATIVE_X', lock_axis: 'LOCK_Z' }),
      identity4(),
      ctxWith({ T: translation4([0, 5, 0]) }),
    ).matrix;
    expectVec(col(m, 0), [0, -1, 0]);
    expectVec(col(m, 1), [1, 0, 0]);
    expectVec(col(m, 2), [0, 0, 1]);
    const t = solve(
      con('TRACK_TO', { track_axis: 'TRACK_Z', up_axis: 'UP_X' }),
      identity4(),
      ctxWith({ T: translation4([0, 0, -3]) }),
    ).matrix;
    expectVec(col(t, 2), [0, 0, -1]);
    expect([0, 1, 2].map((i) => col(t, 0)[i] ** 2).reduce((a, b) => a + b)).toBeCloseTo(1);
  });

  it('orients along the path up vector when the path provides one, and by the tilt otherwise', () => {
    const straight = (extra: Partial<CurveSample>) =>
      polylinePath(
        [
          [0, 0, 0],
          [4, 0, 0],
        ],
        false,
        extra,
      );
    const follow = (path: CurvePath) =>
      solve(
        con('FOLLOW_PATH', { use_curve_follow: true, forward_axis: 'FORWARD_X' }),
        identity4(),
        curveCtx(path, identity4(), { eval_time: 50 }),
      ).matrix;
    const flipped = follow(straight({ up: [0, 0, -1] }));
    expectVec(col(flipped, 0), [1, 0, 0]);
    expectVec(col(flipped, 2), [0, 0, -1]);
    const tilted = follow(straight({ tilt: Math.PI / 2 }));
    expectVec(col(tilted, 2), [0, -1, 0]);
    expectVec(col(tilted, 1), [0, 0, 1]);
  });

  it('clamps onto a transformed curve in curve space', () => {
    const line = polylinePath([
      [0, 0, 0],
      [10, 0, 0],
    ]);
    const point = (co: Vec3) => ({
      co,
      handle_left: null,
      handle_right: null,
      handle_left_type: 'AUTO' as const,
      handle_right_type: 'AUTO' as const,
      radius: 1,
      tilt: 0,
      weight: 1,
    });
    const spline = {
      type: 'POLY' as const,
      points: [point([0, 0, 0]), point([10, 0, 0])],
      use_cyclic_u: false,
      resolution_u: 0,
      order_u: 4,
      use_endpoint_u: true,
      use_smooth: true,
      material_index: 0,
    };
    const ctx = curveCtx(line, translation4([0, 10, 0]), { splines: [spline] });
    expectVec(loc(solve(con('CLAMP_TO'), translation4([3, 0, 5]), ctx).matrix), [3, 10, 0]);
    const empty = curveCtx(line, identity4(), { splines: [] });
    expectVec(solve(con('CLAMP_TO'), translation4([3, 0, 5]), empty).matrix, translation4([3, 0, 5]));
  });

  it('floors along other axes and pivots in positive ranges', () => {
    const ctx = ctxWith({ T: translation4([2, 0, 0]) });
    expectVec(
      loc(solve(con('FLOOR', { floor_location: 'FLOOR_X' }), translation4([0, 1, 1]), ctx).matrix),
      [2, 1, 1],
    );
    expectVec(
      loc(solve(con('FLOOR', { floor_location: 'FLOOR_NEGATIVE_X' }), translation4([5, 1, 1]), ctx).matrix),
      [2, 1, 1],
    );
    const owner = compose4([0, 0, 0], [0.5, 0, 0], [1, 1, 1]);
    const pivot = ctxWith({ T: translation4([0, 1, 0]) });
    expectVec(loc(solve(con('PIVOT', { rotation_range: 'NX' }), owner, pivot).matrix), [0, 0, 0]);
    const active = loc(solve(con('PIVOT', { rotation_range: 'X' }), owner, pivot).matrix);
    expectVec(active, [0, 1 - Math.cos(0.5), -Math.sin(0.5)]);
  });

  it('parents to bones with Child Of', () => {
    const bone = compose4([1, 0, 0], [0, 0, Math.PI / 2], [1, 1, 1]);
    const ctx = ctxWith(
      { Arm: identity4() },
      { getBoneMatrix: (_a, b) => (b === 'B' ? { matrix: bone, length: 3 } : null) },
    );
    expectVec(solve(con('CHILD_OF', {}, { target: 'Arm', subtarget: 'B' }), identity4(), ctx).matrix, bone);
  });

  it('cannot scale zero-scale axes and copies uniform scale from mirrored targets', () => {
    const flat = compose4([0, 0, 0], [0, 0, 0], [0, 1, 1]);
    const m = solve(
      con('LIMIT_SCALE', { use_min_x: true, min_x: 1, use_min_y: true, min_y: 2 }, { target: null }),
      flat,
      ctxWith({}),
    );
    expect(m.errors).toEqual([]);
    expectVec([Math.hypot(...col(m.matrix, 0)), Math.hypot(...col(m.matrix, 1))], [0, 2]);
    const mirrored = ctxWith({ T: compose4([0, 0, 0], [0, 0, 0], [-1, 2, 4]) });
    const u = decompose4(
      solve(con('COPY_SCALE', { use_make_uniform: true }), identity4(), mirrored).matrix,
    ).scale;
    expectVec(u, [2, 2, 2]);
  });

  it('reads parented object targets and bone targets in LOCAL space', () => {
    const parent = compose4([10, 0, 0], [0, 0, Math.PI / 2], [1, 1, 1]);
    const targetLocal = compose4([1, 2, 3], [0, 0, 0.25], [1, 1, 1]);
    const ctx = ctxWith(
      { T: multiply4(parent, targetLocal) },
      {
        getObjectInfo: (id) =>
          id === 'T' ? { name: 'T', type: 'EMPTY', parentMatrix: parent, basisMatrix: targetLocal } : null,
      },
    );
    const m = solve(con('COPY_TRANSFORMS', { target_space: 'LOCAL' }), identity4(), ctx).matrix;
    expectVec(m, targetLocal);
    // bones: local = the pose channel relative to the rest pose and the posed parent
    const restParent = identity4();
    const poseParent = compose4([0, 0, 0], [0, 0, 0.3], [1, 1, 1]);
    const restChild = translation4([0, 1, 0]);
    const channel = compose4([0, 0, 0], [0, 0, 0.2], [1, 1, 1]);
    const poseChild = multiply4(multiply4(poseParent, multiply4(invert4(restParent), restChild)), channel);
    const armWorld = translation4([5, 0, 0]);
    const pose: ArmaturePose = {
      order: ['P', 'C'],
      bones: new Map([
        [
          'P',
          {
            name: 'P',
            parent: null,
            rest: restParent,
            matrix: poseParent,
            length: 1,
            head: [0, 0, 0],
            tail: [0, 1, 0],
          },
        ],
        [
          'C',
          {
            name: 'C',
            parent: 'P',
            rest: restChild,
            matrix: poseChild,
            length: 1,
            head: [0, 1, 0],
            tail: [0, 2, 0],
          },
        ],
      ]),
    };
    const boneCtx = ctxWith(
      { Arm: armWorld },
      {
        getBoneMatrix: (_a, b) => {
          const pb = pose.bones.get(b);
          return pb ? { matrix: multiply4(armWorld, pb.matrix), length: pb.length } : null;
        },
        getArmaturePose: () => pose,
      },
    );
    const r = solve(
      con('COPY_ROTATION', { target_space: 'LOCAL' }, { target: 'Arm', subtarget: 'C' }),
      identity4(),
      boneCtx,
    );
    expect(r.errors).toEqual([]);
    expect(decompose4(r.matrix).rotation[2]).toBeCloseTo(0.2);
    // without pose information LOCAL bone space is reported instead of guessed
    const noPose = solve(
      con('COPY_ROTATION', { target_space: 'LOCAL' }, { target: 'Arm', subtarget: 'C' }),
      identity4(),
      { ...boneCtx, getArmaturePose: undefined },
    );
    expect(noPose.errors[0].message).toMatch(/needs the evaluated armature pose/);
  });

  it('solves every type at half influence without producing invalid matrices', () => {
    const path = polylinePath([
      [0, 0, 0],
      [4, 0, 0],
      [4, 4, 0],
    ]);
    const ctx = {
      ...curveCtx(path, identity4(), { eval_time: 30 }),
      getWorldMatrix: (id: string) =>
        id === 'T' ? compose4([1, 2, 3], [0.4, 0.5, 0.6], [1.5, 2, 0.5]) : null,
    };
    const owner = compose4([-1, 0.5, 2], [0.1, -0.2, 2.9], [1, 2, 3]);
    for (const t of CONSTRAINT_TYPES) {
      if (t.boneOnly) continue;
      const res = solve(
        con(t.type, {}, { influence: 0.5, target: t.target === 'NONE' ? null : 'T' }),
        owner,
        ctx,
      );
      expect(res.errors, t.type).toEqual([]);
      expect(res.matrix.every(Number.isFinite), t.type).toBe(true);
    }
  });
});
