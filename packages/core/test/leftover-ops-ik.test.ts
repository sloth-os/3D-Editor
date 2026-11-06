import { describe, expect, it } from 'vitest';
import { SceneDoc, createEditorState, createOperatorRegistry, type OperatorContext } from '../src';
import { clampIkRotation, ikSettingsOf, solveIk, type IkBone } from '../src/armature/ik';
import { quatFromAxisAngle } from '../src/math/quat';
import { identity4 } from '../src/math/mat4';

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
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

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
        Math.acos(Math.min(1, (a[0] * c[0] + a[1] * c[1] + a[2] * c[2]) / Math.hypot(...a) / Math.hypot(...c)));
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
    t.ok('pose.ik_settings_set', { object: 'Arm', bone: 'Fore', lock_ik_y: false, lock_ik_z: false, use_ik_limit_x: false });
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
    ok('armature.bone_add', { object: 'Rig', name: 'Tool', head: [1, 0, 1.5], tail: [1.2, 0, 1.5], parent: 'Fore' });
    reports.length = 0;
    const r = ok('pose.ik_settings_set', { object: 'Rig', bone: 'Tool', ik_min_z: -0.5 });
    expect(r.chains).toEqual([]);
    expect(reports.join('\n')).toMatch(/not part of any IK chain/);
    expect(reports.join('\n')).toMatch(/only apply with use_ik_limit_z: true/);
  });
});

describe('IK solver with bone settings', () => {
  it('clamps the swing and twist of a bone to its limits', () => {
    const s = ikSettingsOf({ use_ik_limit_x: true, ik_min_x: -0.2, ik_max_x: 0.3, use_ik_limit_y: true, ik_max_y: 0.1 })!;
    expect(s.limit).toEqual([[-0.2, 0.3], [-Math.PI, 0.1], null]);
    expect(clampIkRotation(quatFromAxisAngle([1, 0, 0], 0.25), s)).toBeNull();
    const q = clampIkRotation(quatFromAxisAngle([1, 0, 0], 0.8), s)!;
    expect(q[0]).toBeCloseTo(Math.sin(0.15), 9);
    expect(q[3]).toBeCloseTo(Math.cos(0.15), 9);
    const tw = clampIkRotation(quatFromAxisAngle([0, 1, 0], 1), s)!;
    expect(2 * Math.atan2(tw[1], tw[3])).toBeCloseTo(0.1, 9);
    // invalid values fall back to Blender's defaults and are reported
    const problems: string[] = [];
    expect(ikSettingsOf({ use_ik_limit_z: true, ik_max_z: Number.NaN }, (m) => problems.push(m))!.limit[2]).toEqual([
      -Math.PI,
      Math.PI,
    ]);
    expect(problems).toEqual(['ik_max_z is not a number; using 3.1416']);
    expect(ikSettingsOf({ lock_ik_x: false, ik_stiffness_y: 0 })).toBeNull();
  });

  it('never moves a fully locked root and solves the rest of the chain', () => {
    // root along +Y at the origin, child along +Y after it (armature space, unit lengths)
    const child = identity4();
    child[13] = 1;
    const bones: IkBone[] = [
      { matrix: identity4(), length: 1, parent: -1, ik: ikSettingsOf({ lock_ik_x: true, lock_ik_y: true, lock_ik_z: true }) },
      { matrix: child, length: 1, parent: 0 },
    ];
    solveIk(bones, [
      { bones: [0, 1], target: [0.7, 1.5, 0], pole: null, poleAngle: 0, iterations: 500, useStretch: false, influence: 1 },
    ]);
    expect(bones[0].matrix.map((v) => +v.toFixed(9))).toEqual(identity4());
    // the child can reach the goal only if it is within its length of the root's tail
    const tip = [bones[1].matrix[12] + bones[1].matrix[4], bones[1].matrix[13] + bones[1].matrix[5], bones[1].matrix[14] + bones[1].matrix[6]];
    expect(dist(tip, [0.7, 1.5, 0])).toBeLessThan(0.15);
    expect(dist([bones[1].matrix[12], bones[1].matrix[13], bones[1].matrix[14]], [0, 1, 0])).toBeLessThan(1e-12);
  });
});
