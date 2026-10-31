import { describe, expect, it } from 'vitest';
import {
  alignYToVector,
  boneRestMatrix,
  boneRotation,
  computePose,
  rollFromMatrix,
  rollFromZAxis,
  type PoseContext,
} from '../src/armature';
import { defaultArmature, defaultBone, defaultPoseBone } from '../src/doc/defaults';
import type { ArmatureData, BoneData, ConstraintData, PoseBone } from '../src/doc/types';
import { identity4, invert4, multiply4, rotationFromEuler, translation4 } from '../src/math/mat4';
import type { Mat4, Vec3 } from '../src/math/types';

/** Pose context of the armature object 'rig' (targets 'rig' + subtarget = bones of this armature). */
const ctx = (over: Partial<PoseContext> = {}): PoseContext => ({
  frame: 1,
  armatureMatrix: identity4(),
  armatureId: 'rig',
  getWorldMatrix: () => null,
  ...over,
});

function bone(name: string, head: Vec3, tail: Vec3, extra: Partial<BoneData> = {}): BoneData {
  return { ...defaultBone(name, head, tail), ...extra };
}

function armature(bones: BoneData[], extra: Partial<ArmatureData> = {}): ArmatureData {
  return { ...defaultArmature('arm', 'Armature'), bones, ...extra };
}

function poseBone(p: Partial<PoseBone> = {}): PoseBone {
  return { ...defaultPoseBone(), ...p };
}

const axis = (m: Mat4, c: 0 | 1 | 2): Vec3 => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];

function expectVec(a: readonly number[], b: readonly number[], digits = 6): void {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v, `component ${i} of [${a.join(', ')}]`).toBeCloseTo(b[i], digits));
}

function expectOrthonormal(m: Mat4): void {
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const a = axis(m, i as 0 | 1 | 2);
      const b = axis(m, j as 0 | 1 | 2);
      expect(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).toBeCloseTo(i === j ? 1 : 0, 9);
    }
  // right handed: X × Y = Z
  const x = axis(m, 0);
  const y = axis(m, 1);
  const z = axis(m, 2);
  expectVec([x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]], z, 9);
}

describe('bone rest matrices (Blender roll convention)', () => {
  it('builds the canonical axes for axis-aligned bones', () => {
    // pointing up +Z (Blender's default bone): X stays +X, Z points to -Y (front)
    const up = boneRestMatrix([0, 0, 0], [0, 0, 1], 0);
    expect(up.length).toBeCloseTo(1);
    expectVec(axis(up.matrix, 0), [1, 0, 0]);
    expectVec(axis(up.matrix, 1), [0, 0, 1]);
    expectVec(axis(up.matrix, 2), [0, -1, 0]);
    // along +Y: identity rotation
    expectVec(boneRestMatrix([0, 0, 0], [0, 2, 0], 0).matrix.slice(0, 12), identity4().slice(0, 12));
    // along -Y: half turn about Z
    const down = boneRestMatrix([0, 0, 0], [0, -1, 0], 0).matrix;
    expectVec(axis(down, 0), [-1, 0, 0]);
    expectVec(axis(down, 1), [0, -1, 0]);
    expectVec(axis(down, 2), [0, 0, 1]);
    // along +X: X → -Y, Z stays +Z
    const right = boneRestMatrix([1, 2, 3], [3, 2, 3], 0);
    expect(right.length).toBeCloseTo(2);
    expectVec(axis(right.matrix, 0), [0, -1, 0]);
    expectVec(axis(right.matrix, 2), [0, 0, 1]);
    expectVec(right.matrix.slice(12, 15), [1, 2, 3]);
    // pointing down -Z: Z points to +Y (back)
    const legs = boneRestMatrix([0, 0, 1], [0, 0, 0], 0).matrix;
    expectVec(axis(legs, 0), [1, 0, 0]);
    expectVec(axis(legs, 2), [0, 1, 0]);
  });

  it('applies the roll right-handed about the bone axis', () => {
    const m = boneRestMatrix([0, 0, 0], [0, 0, 1], Math.PI / 2).matrix;
    expectVec(axis(m, 0), [0, 1, 0]);
    expectVec(axis(m, 1), [0, 0, 1]);
    expectVec(axis(m, 2), [1, 0, 0]);
  });

  it('is orthonormal for arbitrary directions and rolls, and the roll round-trips', () => {
    const dirs: Vec3[] = [
      [1, 1, 1],
      [-0.3, 0.2, -0.9],
      [0.001, -1, 0.0005],
      [5, -0.01, 0],
      [-2, 3, 0.5],
    ];
    for (const d of dirs)
      for (const roll of [0, 0.4, -2.5, 3]) {
        const { matrix } = boneRestMatrix([0.5, -1, 2], [0.5 + d[0], -1 + d[1], 2 + d[2]], roll);
        expectOrthonormal(matrix);
        const l = Math.hypot(...d);
        expectVec(axis(matrix, 1), [d[0] / l, d[1] / l, d[2] / l], 9);
        const r = rollFromMatrix(matrix);
        expect(Math.cos(r)).toBeCloseTo(Math.cos(roll), 6);
        expect(Math.sin(r)).toBeCloseTo(Math.sin(roll), 6);
      }
    // within ~2.5e-4 rad of -Y the frame snaps to the canonical half turn about Z (stable roll)
    const nearDown = boneRestMatrix([0, 0, 0], [1e-7, -1, 1e-7], 0).matrix;
    expectVec(axis(nearDown, 0), [-1, 0, 0]);
    expectVec(axis(nearDown, 2), [0, 0, 1]);
    // shortest arc: rotation axis is perpendicular to both Y and the direction
    const b = alignYToVector([1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)]);
    expectVec(axis(b, 0), [0.788675, -0.57735, -0.211325], 5);
    expectVec(boneRotation([0, 1, 0], 0).slice(0, 12), identity4().slice(0, 12));
  });

  it('computes the roll that aligns the Z axis with a vector', () => {
    for (const target of [
      [0, 0, 1],
      [1, 0, 0],
      [-1, -1, 0.3],
    ] as Vec3[]) {
      const head: Vec3 = [0, 0, 0];
      const tail: Vec3 = [1, 0.2, -0.1];
      const roll = rollFromZAxis(head, tail, target);
      const m = boneRestMatrix(head, tail, roll).matrix;
      const z = axis(m, 2);
      const y = axis(m, 1);
      // projected target
      const d = target[0] * y[0] + target[1] * y[1] + target[2] * y[2];
      const p = [target[0] - y[0] * d, target[1] - y[1] * d, target[2] - y[2] * d];
      const pl = Math.hypot(p[0], p[1], p[2]);
      expectVec(z, [p[0] / pl, p[1] / pl, p[2] / pl], 9);
    }
    expect(rollFromZAxis([0, 0, 0], [0, 0, 1], [0, 0, 5])).toBe(0); // parallel: undefined → 0
  });
});

describe('computePose', () => {
  const chain = () =>
    armature([
      bone('Root', [0, 0, 0], [0, 0, 1]),
      bone('Mid', [0, 0, 1], [0, 0, 2], { parent: 'Root', use_connect: true }),
      bone('Tip', [0, 0, 2], [0, 0, 3], { parent: 'Mid', use_connect: true }),
    ]);

  it('returns rest matrices without a pose and orders parents first', () => {
    const arm = armature([
      bone('Child', [0, 0, 1], [0, 1, 1], { parent: 'Root' }),
      bone('Root', [0, 0, 0], [0, 0, 1]),
    ]);
    const pose = computePose(arm, {}, ctx());
    expect(pose.order).toEqual(['Root', 'Child']);
    expect(pose.errors).toEqual([]);
    const c = pose.bones.get('Child')!;
    expect(c.parent).toBe('Root');
    expectVec(c.matrix, c.rest);
    expectVec(c.head, [0, 0, 1]);
    expectVec(c.tail, [0, 1, 1]);
    expect(c.length).toBeCloseTo(1);
    expect(c.deform).toBe(true);
    expect(c.envelope).toMatchObject({ distance: 0.25, weight: 1, headRadius: 0.1, tailRadius: 0.05 });
  });

  it('poses children through their parents (bone-local rotations)', () => {
    // rotate Root +90° about its local X: the chain swings from +Z to -Y
    const pose = computePose(chain(), { Root: poseBone({ rotation_euler: [Math.PI / 2, 0, 0] }) }, ctx());
    expectVec(pose.bones.get('Root')!.tail, [0, -1, 0]);
    expectVec(pose.bones.get('Mid')!.head, [0, -1, 0]);
    expectVec(pose.bones.get('Tip')!.tail, [0, -3, 0]);
    // a second, local rotation on Mid composes with the parent's
    const bent = computePose(
      chain(),
      {
        Root: poseBone({ rotation_euler: [Math.PI / 2, 0, 0] }),
        Mid: poseBone({ rotation_euler: [-Math.PI / 2, 0, 0] }),
      },
      ctx(),
    );
    expectVec(bent.bones.get('Mid')!.tail, [0, -1, 1]);
    expectVec(bent.bones.get('Tip')!.tail, [0, -1, 2]);
    // twist about the bone's own Y axis keeps the tail in place
    const twist = computePose(chain(), { Mid: poseBone({ rotation_euler: [0, 1.2, 0] }) }, ctx());
    expectVec(twist.bones.get('Tip')!.tail, [0, 0, 3]);
    expect(twist.bones.get('Tip')!.matrix[0]).toBeCloseTo(Math.cos(1.2));
  });

  it('keeps connected heads on the parent tail and ignores their pose location', () => {
    const arm = chain();
    arm.bones[1] = { ...arm.bones[1], head: [5, 5, 5] }; // stale head: snapped to the parent's tail
    const pose = computePose(arm, { Mid: poseBone({ location: [3, 0, 0] }) }, ctx());
    expectVec(pose.bones.get('Mid')!.head, [0, 0, 1]);
    expectVec(pose.bones.get('Mid')!.restHead!, [0, 0, 1]);
    // disconnected children move in their parent's bone space
    const free = armature([
      bone('Root', [0, 0, 0], [0, 0, 1]),
      bone('Hand', [1, 0, 1], [1, 0, 2], { parent: 'Root' }),
    ]);
    const moved = computePose(free, { Hand: poseBone({ location: [0, 0.5, 0] }) }, ctx());
    expectVec(moved.bones.get('Hand')!.head, [1, 0, 1.5]); // bone Y = world +Z
  });

  it('inherits pose scale and uses the rest pose with pose_position REST', () => {
    const scaled = computePose(chain(), { Root: poseBone({ scale: [2, 2, 2] }) }, ctx());
    expectVec(scaled.bones.get('Mid')!.head, [0, 0, 2]);
    expectVec(scaled.bones.get('Tip')!.tail, [0, 0, 6]);
    const rest = computePose(
      { ...chain(), pose_position: 'REST' },
      { Root: poseBone({ rotation_euler: [1, 0, 0], scale: [2, 2, 2] }) },
      ctx(),
    );
    for (const b of rest.bones.values()) expectVec(b.matrix, b.rest);
  });

  it('places bones at their rest positions in armature space regardless of the armature transform', () => {
    const pose = computePose(chain(), {}, ctx({ armatureMatrix: translation4([10, 0, 0]) }));
    expectVec(pose.bones.get('Tip')!.tail, [0, 0, 3]);
  });

  it('reports invalid data instead of throwing', () => {
    const arm = armature([
      bone('A', [0, 0, 0], [0, 0, 1], { parent: 'B' }),
      bone('B', [0, 0, 1], [0, 0, 2], { parent: 'A' }),
      bone('A', [9, 9, 9], [9, 9, 10]),
      bone('Lost', [0, 0, 0], [1, 0, 0], { parent: 'Nobody' }),
      bone('Zero', [1, 1, 1], [1, 1, 1]),
      bone('Nan', [NaN, 0, 0], [0, 0, 1]),
    ]);
    const pose = computePose(
      arm,
      { A: { location: [NaN, 1, 1], rotation_euler: [0, 0, 0], scale: [1, 1, 1] } },
      ctx(),
    );
    expect(pose.order.sort()).toEqual(['A', 'B', 'Lost', 'Nan', 'Zero']);
    const errors = pose.errors!.join('\n');
    expect(errors).toMatch(/duplicate bone name "A"/);
    expect(errors).toMatch(/cycle/);
    expect(errors).toMatch(/parent "Nobody" not found/);
    expect(errors).toMatch(/"Zero" has zero length/);
    expect(errors).toMatch(/"Nan" head/);
    expect(errors).toMatch(/pose bone "A" location/);
    for (const b of pose.bones.values()) expect(b.matrix.every(Number.isFinite)).toBe(true);
    expect(computePose(armature([]), {}, ctx())).toEqual({ bones: new Map(), order: [], errors: [] });
  });
});

function ik(params: Record<string, unknown>, extra: Partial<ConstraintData> = {}): ConstraintData {
  return {
    id: 'ik',
    name: 'IK',
    type: 'IK',
    mute: false,
    influence: 1,
    target: 'target',
    subtarget: '',
    show_expanded: true,
    params,
    ...extra,
  };
}

const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('IK constraint', () => {
  // two-bone "arm" pointing up, slightly bent forward (-Y) at the elbow
  const arm = () =>
    armature([
      bone('Upper', [0, 0, 0], [0, -0.1, 1]),
      bone('Lower', [0, -0.1, 1], [0, 0, 2], { parent: 'Upper', use_connect: true }),
    ]);
  const targetAt = (p: Vec3, extra: Record<string, Mat4> = {}) =>
    ctx({ getWorldMatrix: (id) => (id === 'target' ? translation4(p) : (extra[id] ?? null)) });

  it('reaches reachable targets keeping bone lengths and the root in place', () => {
    for (const goal of [
      [0, -1, 1],
      [0.8, 0.3, 0.9],
      [0.2, -0.4, -1.2],
    ] as Vec3[]) {
      const pose = computePose(
        arm(),
        { Lower: poseBone({ constraints: [ik({ chain_count: 2 })] }) },
        targetAt(goal),
      );
      const up = pose.bones.get('Upper')!;
      const lo = pose.bones.get('Lower')!;
      expect(pose.errors).toEqual([]);
      expect(dist(lo.tail, goal)).toBeLessThan(1e-4);
      expectVec(up.head, [0, 0, 0]);
      expect(dist(up.head, up.tail)).toBeCloseTo(up.length, 6);
      expect(dist(lo.head, lo.tail)).toBeCloseTo(lo.length, 6);
      expect(dist(up.tail, lo.head)).toBeLessThan(1e-9);
    }
  });

  it('straightens towards unreachable targets', () => {
    const pose = computePose(arm(), { Lower: poseBone({ constraints: [ik({})] }) }, targetAt([0, 0, 10]));
    const lo = pose.bones.get('Lower')!;
    const total = pose.bones.get('Upper')!.length + lo.length;
    expectVec(lo.tail, [0, 0, total], 6);
    // stretch reaches it
    const stretched = computePose(
      arm(),
      { Lower: poseBone({ constraints: [ik({ use_stretch: true })] }) },
      targetAt([0, 3, 0]),
    );
    expect(dist(stretched.bones.get('Lower')!.tail, [0, 3, 0])).toBeLessThan(1e-6);
  });

  it('bends a perfectly straight chain and follows the pole target', () => {
    const straight = armature([
      bone('Upper', [0, 0, 0], [0, 0, 1]),
      bone('Lower', [0, 0, 1], [0, 0, 2], { parent: 'Upper', use_connect: true }),
    ]);
    const goal: Vec3 = [0, 0, 1.2];
    // no pole: bends towards the root's -Z axis (= +Y for a bone pointing up)
    const free = computePose(straight, { Lower: poseBone({ constraints: [ik({})] }) }, targetAt(goal));
    expect(dist(free.bones.get('Lower')!.tail, goal)).toBeLessThan(1e-4);
    expect(free.bones.get('Upper')!.tail[1]).toBeGreaterThan(0.5);
    for (const side of [1, -1]) {
      const pose = computePose(
        straight,
        { Lower: poseBone({ constraints: [ik({ pole_target: 'pole' })] }) },
        targetAt(goal, { pole: translation4([side * 3, 0, 0.6]) }),
      );
      const elbow = pose.bones.get('Upper')!.tail;
      expect(dist(pose.bones.get('Lower')!.tail, goal)).toBeLessThan(1e-4);
      expect(Math.sign(elbow[0])).toBe(side);
      expect(Math.abs(elbow[1])).toBeLessThan(1e-6);
    }
  });

  it('turns the root X axis (rotated by pole_angle) towards the pole', () => {
    const goal: Vec3 = [0, -0.5, 1.5];
    for (const [angle, ax] of [
      [0, 0],
      [Math.PI / 2, 2],
      [-Math.PI / 2, 2],
    ] as [number, 0 | 2][]) {
      const pose = computePose(
        arm(),
        { Lower: poseBone({ constraints: [ik({ pole_target: 'pole', pole_angle: angle })] }) },
        targetAt(goal, { pole: translation4([4, 0, 0.5]) }),
      );
      const up = pose.bones.get('Upper')!;
      expect(dist(pose.bones.get('Lower')!.tail, goal)).toBeLessThan(1e-4);
      // up vector = X cos(a) + Z sin(a), projected perpendicular to root → goal
      const x = axis(up.matrix, 0);
      const z = axis(up.matrix, 2);
      const u = [0, 1, 2].map((k) => x[k] * Math.cos(angle) + z[k] * Math.sin(angle));
      const g = [goal[0], goal[1], goal[2]];
      const gl = Math.hypot(...g);
      const along = (u[0] * g[0] + u[1] * g[1] + u[2] * g[2]) / gl;
      const perp = u.map((v, k) => v - (g[k] / gl) * along);
      const pl = Math.hypot(...perp);
      // pole direction projected the same way
      const p = [4, 0, 0.5];
      const pa = (p[0] * g[0] + p[1] * g[1] + p[2] * g[2]) / gl;
      const pp = p.map((v, k) => v - (g[k] / gl) * pa);
      const ppl = Math.hypot(...pp);
      expect((perp[0] * pp[0] + perp[1] * pp[1] + perp[2] * pp[2]) / (pl * ppl)).toBeCloseTo(1, 5);
      void ax;
    }
  });

  it('respects chain_count, use_tail and influence', () => {
    const three = armature([
      bone('A', [0, 0, 0], [0, 0, 1]),
      bone('B', [0, 0, 1], [0, -0.1, 2], { parent: 'A', use_connect: true }),
      bone('C', [0, -0.1, 2], [0, 0, 3], { parent: 'B', use_connect: true }),
    ]);
    const goal: Vec3 = [0, -1.2, 1.8];
    const one = computePose(
      three,
      { C: poseBone({ constraints: [ik({ chain_count: 2 })] }) },
      targetAt(goal),
    );
    expectVec(one.bones.get('A')!.matrix, one.bones.get('A')!.rest); // A is not in the chain
    expect(dist(one.bones.get('C')!.tail, goal)).toBeLessThan(1e-4);
    // use_tail off: the chain ends at C's head (= B's tail); C itself only follows
    const head = computePose(
      three,
      { C: poseBone({ constraints: [ik({ use_tail: false })] }) },
      targetAt([0, -0.8, 1.2]),
    );
    expect(dist(head.bones.get('C')!.head, [0, -0.8, 1.2])).toBeLessThan(1e-4);
    // influence 0.5 moves partially
    const half = computePose(
      three,
      { C: poseBone({ constraints: [ik({}, { influence: 0.5 })] }) },
      targetAt(goal),
    );
    const d = dist(half.bones.get('C')!.tail, goal);
    expect(d).toBeGreaterThan(1e-3);
    expect(d).toBeLessThan(dist([0, 0, 3], goal));
    // muted: no effect
    const muted = computePose(
      three,
      { C: poseBone({ constraints: [ik({}, { mute: true })] }) },
      targetAt(goal),
    );
    expectVec(muted.bones.get('C')!.tail, [0, 0, 3]);
  });

  it('targets bones of the same armature (subtarget) and reports missing targets', () => {
    const rig = armature([
      bone('Upper', [0, 0, 0], [0, -0.1, 1]),
      bone('Lower', [0, -0.1, 1], [0, 0, 2], { parent: 'Upper', use_connect: true }),
      bone('Hand_IK', [0.5, -1, 1], [0.5, -1, 1.3]),
    ]);
    const armMatrix = translation4([2, 0, 0]);
    const c = ik({ chain_count: 2 }, { target: 'rig', subtarget: 'Hand_IK' });
    // explicit armature id
    const pose = computePose(
      rig,
      { Lower: poseBone({ constraints: [c] }), Hand_IK: poseBone({ location: [0, 0.2, 0] }) },
      ctx({
        armatureMatrix: armMatrix,
        armatureId: 'rig',
        getWorldMatrix: (id) => (id === 'rig' ? armMatrix : null),
      }),
    );
    expect(dist(pose.bones.get('Lower')!.tail, pose.bones.get('Hand_IK')!.head)).toBeLessThan(1e-4);
    expectVec(pose.bones.get('Hand_IK')!.head, [0.5, -1, 1.2]);
    expect(pose.errors).toEqual([]);
    // without armatureId nothing is guessed: 'rig' is another object, whose bones need getBoneMatrix
    const other = computePose(
      rig,
      { Lower: poseBone({ constraints: [c] }) },
      ctx({
        armatureMatrix: armMatrix,
        armatureId: undefined,
        getWorldMatrix: (id) => (id === 'rig' ? armMatrix.slice() : null),
      }),
    );
    expect(other.errors!.join()).toMatch(/bone "Hand_IK" of another armature cannot be resolved/);
    expectVec(other.bones.get('Lower')!.tail, [0, 0, 2]);
    // a missing bone of this armature
    const noBone = computePose(
      rig,
      { Lower: poseBone({ constraints: [ik({}, { target: 'rig', subtarget: 'Nope' })] }) },
      ctx({ armatureMatrix: armMatrix }),
    );
    expect(noBone.errors).toEqual(['bone "Lower" constraint "IK": IK target bone "Nope" not found']);
    // missing target object
    const missing = computePose(rig, { Lower: poseBone({ constraints: [ik({})] }) }, ctx());
    expect(missing.errors!.join()).toMatch(/IK target not found/);
    expectVec(missing.bones.get('Lower')!.tail, [0, 0, 2]);
    // object targets are converted from world space into armature space
    const world = computePose(
      rig,
      { Lower: poseBone({ constraints: [ik({ chain_count: 2 })] }) },
      ctx({
        armatureMatrix: armMatrix,
        getWorldMatrix: (id) => (id === 'target' ? translation4([2, -1, 1]) : null),
      }),
    );
    expect(dist(world.bones.get('Lower')!.tail, [0, -1, 1])).toBeLessThan(1e-4);
  });

  it('detects dependency cycles between a chain and its target', () => {
    const rig = armature([
      bone('Upper', [0, 0, 0], [0, -0.1, 1]),
      bone('Lower', [0, -0.1, 1], [0, 0, 2], { parent: 'Upper', use_connect: true }),
      bone('Child', [0, 0, 2], [0, 0, 2.5], { parent: 'Lower' }),
    ]);
    const pose = computePose(
      rig,
      { Lower: poseBone({ constraints: [ik({}, { target: 'rig', subtarget: 'Child' })] }) },
      ctx(),
    );
    expect(pose.errors!.join()).toMatch(/dependency cycle/);
    for (const b of pose.bones.values()) expect(b.matrix.every(Number.isFinite)).toBe(true);
    // the provisional child is evaluated again once the cycle is left: it follows the solved chain
    expect(dist(pose.bones.get('Child')!.head, pose.bones.get('Lower')!.tail)).toBeLessThan(1e-9);
  });

  it('solves chains that share bones together (poles are ignored there)', () => {
    // a spine with two arms: both IK chains include the spine
    const rig = armature([
      bone('Spine', [0, 0, 0], [0, 0, 1]),
      bone('ArmL', [0, 0, 1], [1, 0, 1.1], { parent: 'Spine', use_connect: true }),
      bone('ArmR', [0, 0, 1], [-1, 0, 1.1], { parent: 'Spine', use_connect: true }),
    ]);
    const goals: Record<string, Vec3> = { L: [1, -0.5, 0.9], R: [-1, -0.5, 0.9] };
    const pose = computePose(
      rig,
      {
        ArmL: poseBone({ constraints: [ik({ chain_count: 2, pole_target: 'pole' }, { target: 'L' })] }),
        ArmR: poseBone({ constraints: [ik({ chain_count: 2 }, { target: 'R' })] }),
      },
      ctx({
        getWorldMatrix: (id) => (goals[id] ? translation4(goals[id]) : id === 'pole' ? identity4() : null),
      }),
    );
    expect(pose.errors!.join()).toMatch(/pole targets are ignored/);
    // symmetric goals: the spine leans forward and both hands reach their goals
    expect(dist(pose.bones.get('ArmL')!.tail, goals.L)).toBeLessThan(0.02);
    expect(dist(pose.bones.get('ArmR')!.tail, goals.R)).toBeLessThan(0.02);
    expect(pose.bones.get('Spine')!.tail[1]).toBeLessThan(-0.1);
  });

  it('reports bone sub-targets of other armatures that the context cannot resolve', () => {
    const rig = armature([
      bone('Upper', [0, 0, 0], [0, -0.1, 1]),
      bone('Lower', [0, -0.1, 1], [0, 0, 2], { parent: 'Upper', use_connect: true }),
    ]);
    const other = translation4([0, -1, 1]);
    const c = ik({}, { target: 'other', subtarget: 'Hand' });
    const pose = computePose(
      rig,
      { Lower: poseBone({ constraints: [c] }) },
      ctx({ getWorldMatrix: (id) => (id === 'other' ? other : null) }),
    );
    // never the other armature's origin: the IK is skipped and the problem reported
    expect(pose.errors!.join()).toMatch(/bone "Hand" of another armature cannot be resolved/);
    expectVec(pose.bones.get('Lower')!.tail, [0, 0, 2]);
    // a bone the other armature does not have
    const missing = computePose(
      rig,
      { Lower: poseBone({ constraints: [c] }) },
      ctx({ getWorldMatrix: (id) => (id === 'other' ? other : null), getBoneMatrix: () => null }),
    );
    expect(missing.errors).toEqual(['bone "Lower" constraint "IK": IK target bone "Hand" not found']);
    expectVec(missing.bones.get('Lower')!.tail, [0, 0, 2]);
    // with getBoneMatrix the bone itself is used
    const withBones = computePose(
      rig,
      { Lower: poseBone({ constraints: [c] }) },
      ctx({
        getWorldMatrix: (id) => (id === 'other' ? other : null),
        getBoneMatrix: (a, b) =>
          a === 'other' && b === 'Hand' ? { matrix: translation4([0.5, -1, 1]), length: 1 } : null,
      }),
    );
    expect(withBones.errors).toEqual([]);
    expect(dist(withBones.bones.get('Lower')!.tail, [0.5, -1, 1])).toBeLessThan(1e-4);
  });
});

function constraint(
  type: string,
  params: Record<string, unknown>,
  extra: Partial<ConstraintData> = {},
): ConstraintData {
  return {
    id: type,
    name: type,
    type: type as ConstraintData['type'],
    mute: false,
    influence: 1,
    target: null,
    subtarget: '',
    show_expanded: true,
    params,
    ...extra,
  };
}

describe('bone constraints', () => {
  const rig = () =>
    armature([
      bone('Driver', [2, 0, 0], [2, 0, 1]),
      bone('Follower', [0, 0, 0], [0, 0, 1]),
      bone('Child', [0, 0, 1], [0, 0, 2], { parent: 'Follower', use_connect: true }),
    ]);

  it('copies the rotation of another bone (world/pose space) and children follow', () => {
    const pose = computePose(
      rig(),
      {
        Driver: poseBone({ rotation_euler: [0.7, 0, 0] }),
        Follower: poseBone({ constraints: [constraint('COPY_ROTATION', {}, { target: 'rig', subtarget: 'Driver' })] }),
      },
      ctx(),
    );
    const d = pose.bones.get('Driver')!.matrix;
    const f = pose.bones.get('Follower')!.matrix;
    expectVec(f.slice(0, 11), d.slice(0, 11));
    expectVec(f.slice(12, 15), [0, 0, 0]);
    expectVec(pose.bones.get('Child')!.head, pose.bones.get('Follower')!.tail);
  });

  it('copies local rotations with LOCAL spaces and blends by influence', () => {
    const local = computePose(
      rig(),
      {
        Driver: poseBone({ rotation_euler: [0.5, 0, 0] }),
        Follower: poseBone({
          constraints: [
            constraint(
              'COPY_ROTATION',
              { target_space: 'LOCAL', owner_space: 'LOCAL', use_y: false, use_z: false },
              { target: 'rig', subtarget: 'Driver', influence: 0.5 },
            ),
          ],
        }),
      },
      ctx(),
    );
    const f = local.bones.get('Follower')!.tail;
    // half of a 0.5 rad local X rotation of a bone pointing up: tail tilts towards -Y
    expectVec(f, [0, -Math.sin(0.25), Math.cos(0.25)], 6);
  });

  it('tracks targets with DAMPED_TRACK and limits local rotation with LIMIT_ROTATION', () => {
    const tracked = computePose(
      rig(),
      { Follower: poseBone({ constraints: [constraint('DAMPED_TRACK', {}, { target: 'target' })] }) },
      ctx({ getWorldMatrix: (id) => (id === 'target' ? translation4([3, 0, 0]) : null) }),
    );
    const t = tracked.bones.get('Follower')!;
    expectVec(t.tail, [1, 0, 0]);
    const limited = computePose(
      rig(),
      {
        Follower: poseBone({
          rotation_euler: [1.2, 0, 0],
          constraints: [constraint('LIMIT_ROTATION', { use_limit_x: true, min_x: -0.5, max_x: 0.5 })],
        }),
      },
      ctx(),
    );
    expectVec(limited.bones.get('Follower')!.tail, [0, -Math.sin(0.5), Math.cos(0.5)], 6);
    // copy location from an object, then unsupported types are reported and skipped
    const copied = computePose(
      rig(),
      {
        Follower: poseBone({
          constraints: [
            constraint('COPY_LOCATION', { use_z: false }, { target: 'target' }),
            constraint('FOLLOW_PATH', {}, { target: 'target' }),
          ],
        }),
      },
      ctx({ getWorldMatrix: (id) => (id === 'target' ? translation4([1, 2, 3]) : null) }),
    );
    expectVec(copied.bones.get('Follower')!.head, [1, 2, 0]);
    expect(copied.errors!.join()).toMatch(/FOLLOW_PATH is not supported on bones/);
  });

  it('mixes copied rotations (ADD, BEFORE, AFTER) and filters axes', () => {
    const rotOf = (mix: string, extra: Record<string, unknown> = {}) =>
      computePose(
        rig(),
        {
          Driver: poseBone({ rotation_euler: [0, 0, 0.4] }),
          Follower: poseBone({
            rotation_euler: [0.3, 0, 0],
            constraints: [
              constraint(
                'COPY_ROTATION',
                { mix_mode: mix, target_space: 'LOCAL', owner_space: 'LOCAL', ...extra },
                { target: 'rig', subtarget: 'Driver' },
              ),
            ],
          }),
        },
        ctx(),
      ).bones.get('Follower')!.matrix;
    // in LOCAL space: owner rotation Rx(0.3), copied rotation Rz(0.4)
    const rx = rotationFromEuler([0.3, 0, 0]);
    const rz = rotationFromEuler([0, 0, 0.4]);
    const local = (m: Mat4) => multiply4(invert4(restOf('Follower')), m);
    expectVec(local(rotOf('BEFORE')).slice(0, 11), multiply4(rz, rx).slice(0, 11));
    expectVec(local(rotOf('AFTER')).slice(0, 11), multiply4(rx, rz).slice(0, 11));
    expectVec(local(rotOf('ADD')).slice(0, 11), rotationFromEuler([0.3, 0, 0.4]).slice(0, 11));
    // REPLACE with use_z off keeps the owner's own Z (none) and takes X/Y from the target (0)
    expectVec(local(rotOf('REPLACE', { use_z: false })).slice(0, 11), identity4().slice(0, 11));
    // inverted axis
    expectVec(
      local(rotOf('REPLACE', { invert_z: true })).slice(0, 11),
      rotationFromEuler([0, 0, -0.4]).slice(0, 11),
    );
  });

  it('clamps rotation limits around the circle (or as plain numbers with legacy behaviour)', () => {
    const tailFor = (angle: number, params: Record<string, unknown>) =>
      computePose(
        rig(),
        {
          Follower: poseBone({
            rotation_euler: [angle, 0, 0],
            constraints: [constraint('LIMIT_ROTATION', { use_limit_x: true, ...params })],
          }),
        },
        ctx(),
      ).bones.get('Follower')!.tail;
    const at = (a: number): Vec3 => [0, -Math.sin(a), Math.cos(a)];
    const lim = { min_x: -2.5, max_x: -2 };
    // 2.9 rad is closest to -2.5 (= 3.78) around the circle
    expectVec(tailFor(2.9, lim), at(-2.5));
    // legacy: plain clamp of the number → -2
    expectVec(tailFor(2.9, { ...lim, use_legacy_behavior: true }), at(-2));
    // inside the range (equivalent angle): unchanged
    expectVec(tailFor(-2.2 + 2 * Math.PI, lim), at(-2.2));
  });
});

const restOf = (name: string) =>
  computePose(
    armature([
      bone('Driver', [2, 0, 0], [2, 0, 1]),
      bone('Follower', [0, 0, 0], [0, 0, 1]),
      bone('Child', [0, 0, 1], [0, 0, 2], { parent: 'Follower', use_connect: true }),
    ]),
    {},
    ctx(),
  ).bones.get(name)!.rest;
