import { describe, expect, it } from 'vitest';
import { SceneDoc, createEditorState, createOperatorRegistry, type OperatorContext } from '../src';
import { clampIkRotation, ikSettingsOf, solveIk, type IkBone } from '../src/armature/ik';
import { quatFromRotationMatrix, rotationPart } from '../src/armature/bone-math';
import { FrameState } from '../src/eval/frame-state';
import { multiplyQuat, quatFromAxisAngle } from '../src/math/quat';
import { identity4 } from '../src/math/mat4';
import type { Mat4, Quat } from '../src/math/types';

// Regression tests for the robot-workcell issue "No per-bone IK locks or limits (Blender lock_ik_x/y/z,
// use_ik_limit_*): an IK chain that includes a robot's yaw base tilts the base".

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const reports: string[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'mcp',
    report: (level, message) => reports.push(`${level}: ${message}`),
  };
  const run = (id: string, params?: unknown) => reg.run<any>(ctx, id, params);
  const ok = (id: string, params?: unknown) => {
    const r = run(id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r.result;
  };
  return { doc, ok, run, reports };
}

type Bone = { name: string; posed_head_world: number[]; posed_tail_world: number[] };
const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The issue's rig: a vertical base, an upper arm and a forearm, one IK chain over all three. */
function robot() {
  const t = setup();
  t.ok('object.armature_add', { name: 'Rig', bone_name: 'Base', location: [0, 0, 0] });
  t.ok('armature.bone_update', { object: 'Rig', bone: 'Base', head: [0, 0, 0], tail: [0, 0, 0.5] });
  t.ok('armature.chain_add', {
    object: 'Rig',
    points: [
      [0, 0, 0.5],
      [0, 0, 1.5],
      [1, 0, 1.5],
    ],
    names: ['Upper', 'Fore'],
    parent: 'Base',
    use_connect: true,
  });
  t.ok('object.empty_add', { name: 'T', location: [0.3, 0.9, 0.6] });
  t.ok('pose.ik_add', { object: 'Rig', bone: 'Fore', target: 'T', chain_count: 3 });
  const bones = (): Record<string, Bone> =>
    Object.fromEntries(
      t.ok('armature.describe', { object: 'Rig', frame: 1 }).bones.map((b: Bone) => [b.name, b]),
    );
  return { ...t, bones };
}

describe('pose.ik_settings_set: IK locks, limits and stiffness', () => {
  it('keeps a yaw-only robot base upright while the arm reaches the target', () => {
    const { ok, doc, bones, reports } = robot();
    // without locks the IK chain tilts the base towards the target (the reported behaviour)
    expect(dist(bones().Base.posed_tail_world, [0, 0, 0.5])).toBeGreaterThan(0.05);
    const r = ok('pose.ik_settings_set', { object: 'Rig', bone: 'Base', lock_ik_x: true, lock_ik_z: true });
    expect(r.ik_settings).toMatchObject({ lock_ik_x: true, lock_ik_y: false, lock_ik_z: true });
    expect(r.chains).toEqual([{ bone: 'Fore', constraint: 'IK', chain: ['Base', 'Upper', 'Fore'] }]);
    expect(reports).toEqual([]);
    const T = doc.findObjectByName('T')!.id;
    for (const target of [
      [0.3, 0.9, 0.6],
      [-0.8, 0.4, 1.2],
      [0.2, -1.1, 0.3],
      [-0.5, -0.5, 2],
    ]) {
      doc.updateObject(T, { location: target as [number, number, number] });
      const b = bones();
      // the base only turns about its own (vertical) axis: its tail never leaves [0, 0, 0.5]
      expect(dist(b.Base.posed_tail_world, [0, 0, 0.5])).toBeLessThan(1e-6);
      expect(dist(b.Fore.posed_tail_world, target)).toBeLessThan(1e-4);
    }
    const d = ok('armature.describe', { object: 'Rig' });
    const base = d.bones.find((b: { name: string }) => b.name === 'Base');
    expect(base.ik_settings).toMatchObject({ lock_ik_x: true, lock_ik_z: true });
    expect(d.bones.find((b: { name: string }) => b.name === 'Upper').ik_settings).toBeNull();
    expect(base.x_axis).toHaveLength(3);
  });

  it('limits the bend of a hinge and lets stiff bones move less', () => {
    const t = setup();
    t.ok('object.armature_add', { name: 'Arm', bone_name: 'Upper', location: [0, 0, 0] });
    t.ok('armature.bone_update', { object: 'Arm', bone: 'Upper', head: [0, 0, 0], tail: [0, 0, 1] });
    t.ok('armature.chain_add', {
      object: 'Arm',
      points: [
        [0, 0, 1],
        [0, 0.05, 2],
      ],
      names: ['Fore'],
      parent: 'Upper',
      use_connect: true,
    });
    t.ok('object.empty_add', { name: 'Goal', location: [0, -0.3, 0.5] });
    t.ok('pose.ik_add', { object: 'Arm', bone: 'Fore', target: 'Goal', chain_count: 2 });
    const pose = () => {
      const b: Record<string, Bone> = Object.fromEntries(
        t.ok('armature.describe', { object: 'Arm' }).bones.map((x: Bone) => [x.name, x]),
      );
      const dir = (x: Bone) => x.posed_tail_world.map((v, i) => v - x.posed_head_world[i]);
      const angle = (a: number[], c: number[]) =>
        Math.acos(
          Math.min(1, (a[0] * c[0] + a[1] * c[1] + a[2] * c[2]) / Math.hypot(...a) / Math.hypot(...c)),
        );
      return {
        // bend of the elbow relative to the rest pose (the bones start 0.05 rad apart)
        bend: angle(dir(b.Upper), dir(b.Fore)) - Math.atan2(0.05, 1),
        upper: angle(dir(b.Upper), [0, 0, 1]),
        error: dist(b.Fore.posed_tail_world, t.doc.findObjectByName('Goal')!.location),
      };
    };
    // the goal close to the shoulder needs a 2.5 rad bend
    expect(pose().bend).toBeCloseTo(2.5, 1);
    t.ok('pose.ik_settings_set', {
      object: 'Arm',
      bone: 'Fore',
      lock_ik_y: true,
      lock_ik_z: true,
      use_ik_limit_x: true,
      ik_min_x: -1,
      ik_max_x: 0,
    });
    const limited = pose();
    expect(limited.bend).toBeLessThanOrEqual(1 + 1e-6);
    expect(limited.bend).toBeGreaterThan(0.99);
    // the best the limited arm can do: point straight at the goal with the elbow at its limit
    const fore = Math.hypot(0.05, 1);
    const reach = Math.sqrt(1 + fore * fore + 2 * fore * Math.cos(1 + Math.atan2(0.05, 1)));
    expect(limited.error).toBeCloseTo(reach - Math.hypot(0.3, 0.5), 3);
    // stiffness: a stiff upper arm takes less of the motion
    t.ok('pose.ik_settings_set', {
      object: 'Arm',
      bone: 'Fore',
      lock_ik_y: false,
      lock_ik_z: false,
      use_ik_limit_x: false,
    });
    t.ok('pose.ik_settings_set', { object: 'Arm', bone: 'Fore', use_ik_limit_y: true }); // no-op limit (−π … π)
    t.doc.updateObject(t.doc.findObjectByName('Goal')!.id, { location: [1.5, 0.3, 0.2] });
    const free = pose();
    t.ok('pose.ik_settings_set', {
      object: 'Arm',
      bone: 'Upper',
      ik_stiffness_x: 0.9,
      ik_stiffness_y: 0.9,
      ik_stiffness_z: 0.9,
    });
    const stiff = pose();
    expect(free.error).toBeLessThan(1e-4);
    expect(stiff.error).toBeLessThan(1e-4);
    expect(stiff.upper).toBeLessThan(free.upper - 0.1);
  });

  it('validates and documents the settings', () => {
    const { ok, run, reports } = robot();
    const bad = run('pose.ik_settings_set', { object: 'Rig', bone: 'Base', ik_min_x: 0.5 });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('INVALID_PARAMS');
    expect(run('pose.ik_settings_set', { object: 'Rig', bone: 'Base' })).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS',
    });
    expect(run('pose.ik_settings_set', { object: 'Rig', bone: 'Nope', lock_ik_x: true })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });
    // a bone outside every IK chain: the settings are stored, with a warning
    ok('armature.bone_add', {
      object: 'Rig',
      name: 'Tool',
      head: [1, 0, 1.5],
      tail: [1.2, 0, 1.5],
      parent: 'Fore',
    });
    reports.length = 0;
    const r = ok('pose.ik_settings_set', { object: 'Rig', bone: 'Tool', ik_min_z: -0.5 });
    expect(r.chains).toEqual([]);
    expect(reports.join('\n')).toMatch(/not part of any IK chain/);
    expect(reports.join('\n')).toMatch(/only apply with use_ik_limit_z: true/);
  });
});

describe('IK solver with bone settings', () => {
  it('clamps the swing and twist of a bone to its limits', () => {
    const s = ikSettingsOf({
      use_ik_limit_x: true,
      ik_min_x: -0.2,
      ik_max_x: 0.3,
      use_ik_limit_y: true,
      ik_max_y: 0.1,
    })!;
    expect(s.limit).toEqual([[-0.2, 0.3], [-Math.PI, 0.1], null]);
    expect(clampIkRotation(quatFromAxisAngle([1, 0, 0], 0.25), s)).toBeNull();
    const q = clampIkRotation(quatFromAxisAngle([1, 0, 0], 0.8), s)!;
    expect(q[0]).toBeCloseTo(Math.sin(0.15), 9);
    expect(q[3]).toBeCloseTo(Math.cos(0.15), 9);
    const tw = clampIkRotation(quatFromAxisAngle([0, 1, 0], 1), s)!;
    expect(2 * Math.atan2(tw[1], tw[3])).toBeCloseTo(0.1, 9);
    // invalid values fall back to Blender's defaults and are reported
    const problems: string[] = [];
    expect(
      ikSettingsOf({ use_ik_limit_z: true, ik_max_z: Number.NaN }, (m) => problems.push(m))!.limit[2],
    ).toEqual([-Math.PI, Math.PI]);
    expect(problems).toEqual(['ik_max_z is not a number; using 3.1416']);
    expect(ikSettingsOf({ lock_ik_x: false, ik_stiffness_y: 0 })).toBeNull();
  });

  it('never moves a fully locked root and solves the rest of the chain', () => {
    // root along +Y at the origin, child along +Y after it (armature space, unit lengths)
    const child = identity4();
    child[13] = 1;
    const bones: IkBone[] = [
      {
        matrix: identity4(),
        length: 1,
        parent: -1,
        ik: ikSettingsOf({ lock_ik_x: true, lock_ik_y: true, lock_ik_z: true }),
      },
      { matrix: child, length: 1, parent: 0 },
    ];
    solveIk(bones, [
      {
        bones: [0, 1],
        target: [0.7, 1.5, 0],
        pole: null,
        poleAngle: 0,
        iterations: 500,
        useStretch: false,
        influence: 1,
      },
    ]);
    expect(bones[0].matrix.map((v) => +v.toFixed(9))).toEqual(identity4());
    // the child can reach the goal only if it is within its length of the root's tail
    const tip = [
      bones[1].matrix[12] + bones[1].matrix[4],
      bones[1].matrix[13] + bones[1].matrix[5],
      bones[1].matrix[14] + bones[1].matrix[6],
    ];
    expect(dist(tip, [0.7, 1.5, 0])).toBeLessThan(0.15);
    expect(dist([bones[1].matrix[12], bones[1].matrix[13], bones[1].matrix[14]], [0, 1, 0])).toBeLessThan(
      1e-12,
    );
  });
});

// Verifier follow-up: "IK locks on a single axis are not honoured (lock_ik_y twist up to 87°, lock_ik_x / z
// bend up to 50° / 97°)": steps about the free local axes add up to a rotation about the locked one.
describe('IK with one locked axis per bone', () => {
  const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
  const rot = (m: Mat4): Quat => quatFromRotationMatrix(rotationPart(m));
  /** Rotation relative to the rest frame as Blender's segments see it: q = swing(sx, sz) · twist(y). */
  const swingTwist = (q: Quat) => {
    const tl = Math.hypot(q[1], q[3]);
    const twist = 2 * Math.atan2(q[1] / tl, q[3] / tl);
    let sw = multiplyQuat(q, [0, -q[1] / tl, 0, q[3] / tl]);
    if (sw[3] < 0) sw = [-sw[0], -sw[1], -sw[2], -sw[3]];
    const sl = Math.hypot(sw[0], sw[1], sw[2]);
    const k = sl > 1e-12 ? (2 * Math.atan2(sl, sw[3])) / sl : 2;
    return { x: sw[0] * k, y: Math.atan2(Math.sin(twist), Math.cos(twist)), z: sw[2] * k };
  };

  /** The verifier's two-bone arm (bones not in line, so a bend needs both locked and free axes). */
  function arm(lock: 'lock_ik_x' | 'lock_ik_y' | 'lock_ik_z') {
    const t = setup();
    t.ok('object.armature_add', { name: 'Arm', bone_name: 'Upper', location: [0, 0, 0] });
    t.ok('armature.bone_update', { object: 'Arm', bone: 'Upper', head: [0, 0, 0], tail: [0.6, 0.1, 0] });
    t.ok('armature.chain_add', {
      object: 'Arm',
      points: [
        [0.6, 0.1, 0],
        [1.1, 0.4, 0.1],
      ],
      names: ['Fore'],
      parent: 'Upper',
      use_connect: true,
    });
    const armId = t.doc.findObjectByName('Arm')!.id;
    const bone = (fs: FrameState, name: string) => fs.boneMatrix(armId, name)!.matrix;
    const restFs = new FrameState(t.doc, 1);
    const restU = rot(bone(restFs, 'Upper'));
    const restF = rot(bone(restFs, 'Fore'));
    t.ok('object.empty_add', { name: 'Goal', location: [-0.5, 0.6, -0.4] });
    t.ok('pose.ik_add', { object: 'Arm', bone: 'Fore', target: 'Goal', chain_count: 2 });
    for (const b of ['Upper', 'Fore']) t.ok('pose.ik_settings_set', { object: 'Arm', bone: b, [lock]: true });
    const goalId = t.doc.findObjectByName('Goal')!.id;
    /** Both bones' rotations relative to their rest frames, and the distance of the tip from the goal. */
    const solve = (goal: [number, number, number]) => {
      t.doc.updateObject(goalId, { location: goal });
      const fs = new FrameState(t.doc, 1);
      const U = bone(fs, 'Upper');
      const F = bone(fs, 'Fore');
      const qU = rot(U);
      // Fore's rest frame moves with Upper: Upper's pose · Upper's rest⁻¹ · Fore's rest
      const frameF = multiplyQuat(multiplyQuat(qU, conj(restU)), restF);
      const len = Math.hypot(0.5, 0.3, 0.1);
      const tip = [F[12] + F[4] * len, F[13] + F[5] * len, F[14] + F[6] * len];
      return {
        upper: swingTwist(multiplyQuat(conj(restU), qU)),
        fore: swingTwist(multiplyQuat(conj(frameF), rot(F))),
        error: dist(tip, goal),
        U,
        restU,
      };
    };
    return solve;
  }

  const goals: [number, number, number][] = [
    [-0.5, 0.6, -0.4],
    [-0.2, -0.4, -0.8],
    [0.3, 0.9, 0.6],
    [0.9, -0.3, 0.5],
    [-0.6, -0.6, 0.4],
    [0.2, 0.2, -1],
  ];

  it('never twists a bone with lock_ik_y (swing only) and still reaches every goal', () => {
    const solve = arm('lock_ik_y');
    for (const g of goals) {
      const r = solve(g);
      // the old solver twisted Fore by up to 147° and Upper by 23°
      expect(Math.abs(r.upper.y)).toBeLessThan(1e-9);
      expect(Math.abs(r.fore.y)).toBeLessThan(1e-9);
      expect(r.error).toBeLessThan(1e-4);
    }
  });

  it('bends a bone with lock_ik_x only about its rest Z axis (an elbow with twist)', () => {
    const solve = arm('lock_ik_x');
    for (const g of goals) {
      const r = solve(g);
      expect(Math.abs(r.upper.x)).toBeLessThan(1e-9);
      expect(Math.abs(r.fore.x)).toBeLessThan(1e-9);
      // decomposition-free: Upper's direction stays in its rest X-Y plane (it left it by up to 40°)
      const restZ = multiplyQuat(multiplyQuat(r.restU, [0, 0, 1, 0]), conj(r.restU));
      const dir = [r.U[4], r.U[5], r.U[6]];
      expect(Math.abs(dir[0] * restZ[0] + dir[1] * restZ[1] + dir[2] * restZ[2])).toBeLessThan(1e-9);
    }
    // a goal in reach is reached; one out of reach ends at the closest pose the locks allow
    expect(solve([-0.5, 0.6, -0.4]).error).toBeLessThan(1e-4);
    expect(solve([-0.2, -0.4, -0.8]).error).toBeLessThan(0.23);
  });

  it('bends a bone with lock_ik_z only about its rest X axis', () => {
    const solve = arm('lock_ik_z');
    for (const g of goals) {
      const r = solve(g);
      expect(Math.abs(r.upper.z)).toBeLessThan(1e-9);
      expect(Math.abs(r.fore.z)).toBeLessThan(1e-9);
    }
    expect(solve([0.9, -0.3, 0.5]).error).toBeLessThan(1e-4);
  });
});
