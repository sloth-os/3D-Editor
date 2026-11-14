import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/armature/bone-math', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/armature/bone-math')>();
  return { ...mod, boneRestMatrix: vi.fn(mod.boneRestMatrix) };
});

import { boneRestMatrix } from '../src/armature/bone-math';
import { computePose, createPoseEvaluation } from '../src/armature/pose';
import type { PoseContext } from '../src/armature/types';
import { defaultArmature, defaultBone, defaultPoseBone } from '../src/doc/defaults';
import type { ArmatureData, BoneData, PoseBone } from '../src/doc/types';
import { identity4 } from '../src/math/mat4';
import type { Vec3 } from '../src/math/types';

/*
 * A pose evaluation reads the rest frames of an armature's bones once per armature object while
 * they are unchanged (armature/pose.ts skeletonOf): a move computes hundreds of poses of one
 * armature. Whatever an evaluation hands out stays its own, and a bone changed in place is read
 * again.
 */

const ctx: PoseContext = { frame: 1, armatureMatrix: identity4(), getWorldMatrix: () => null };

function bone(name: string, head: Vec3, tail: Vec3, extra: Partial<BoneData> = {}): BoneData {
  return { ...defaultBone(name, head, tail), ...extra };
}

/** A leg-like chain with a branch: root → hips → thigh → shin, hips → spine. */
function rig(extra: Partial<ArmatureData> = {}): ArmatureData {
  return {
    ...defaultArmature('arm', 'Armature'),
    bones: [
      bone('root', [0, 0, 0], [0, 0.2, 0]),
      bone('hips', [0, 0, 1], [0, 0, 1.2], { parent: 'root', roll: 0.1 }),
      bone('thigh', [0.1, 0, 1], [0.1, 0, 0.5], { parent: 'hips' }),
      bone('shin', [0.1, 0, 0.5], [0.1, 0.05, 0.05], { parent: 'thigh', use_connect: true }),
      bone('spine', [0, 0, 1.2], [0, 0, 1.6], { parent: 'hips', use_connect: true }),
    ],
    ...extra,
  };
}

function pose(angle: number): Record<string, PoseBone> {
  return {
    hips: { ...defaultPoseBone(), location: [0, 0.1 * angle, 0], rotation_euler: [angle, 0, 0] },
    thigh: { ...defaultPoseBone(), rotation_euler: [0.5 * angle, 0, 0.2] },
    shin: { ...defaultPoseBone(), rotation_euler: [-angle, 0, 0] },
  };
}

/** The pose of `arm` read anew from a copy of it (nothing kept from earlier evaluations). */
const fresh = (arm: ArmatureData, p: Record<string, PoseBone>) => computePose(structuredClone(arm), p, ctx);

const restReads = vi.mocked(boneRestMatrix);
beforeEach(() => {
  // (a hook's return value would be called after the test: mockClear returns the mock)
  restReads.mockClear();
});

describe('pose evaluations of one armature object', () => {
  it('read the rest frames of its bones once while they are unchanged', () => {
    const arm = rig();
    const first = computePose(arm, pose(0.3), ctx);
    expect(restReads).toHaveBeenCalledTimes(arm.bones.length);
    for (let i = 1; i <= 20; i++) computePose(arm, pose(0.3 + i / 50), ctx);
    createPoseEvaluation(arm, pose(1), ctx).bone('shin');
    expect(restReads).toHaveBeenCalledTimes(arm.bones.length);
    // and give what reading them anew gives, bit for bit
    for (const angle of [0.3, 0.8, -1.2]) {
      const kept = computePose(arm, pose(angle), ctx);
      const anew = fresh(arm, pose(angle));
      for (const [name, b] of anew.bones) expect(kept.bones.get(name), name).toEqual(b);
      expect(kept.order).toEqual(anew.order);
    }
    expect(first.bones.get('shin')!.matrix).toEqual(fresh(arm, pose(0.3)).bones.get('shin')!.matrix);
  });

  it('read them again when a bone is changed in place, replaced, added or removed', () => {
    const arm = rig();
    const check = (what: string) => {
      const kept = computePose(arm, pose(0.4), ctx);
      const anew = fresh(arm, pose(0.4));
      expect([...kept.bones.keys()], what).toEqual([...anew.bones.keys()]);
      for (const [name, b] of anew.bones) expect(kept.bones.get(name), `${what}: ${name}`).toEqual(b);
      expect(kept.errors, what).toEqual(anew.errors);
    };
    check('as built');
    arm.bones[2].head[0] = 0.15;
    check('a head moved in place');
    arm.bones[2].tail = [0.2, 0, 0.4];
    check('a tail replaced');
    arm.bones[1].roll = 0.7;
    check('a roll');
    arm.bones[3].use_connect = false;
    check('a bone disconnected');
    arm.bones[4].parent = 'root';
    check('a bone parented elsewhere');
    arm.bones[4] = { ...arm.bones[4], name: 'chest' };
    check('a bone renamed');
    arm.bones.push(bone('neck', [0, 0, 1.6], [0, 0, 1.8], { parent: 'chest' }));
    check('a bone added');
    arm.bones.splice(2, 1);
    check('a bone removed (its child becomes a root)');
    arm.bones = [arm.bones[1], arm.bones[0]];
    check('the bones replaced');
  });

  it('use the bone data as it is now for what they do not cache (deform, envelope)', () => {
    const arm = rig();
    computePose(arm, pose(0.2), ctx);
    arm.bones[2].use_deform = false;
    arm.bones[2].envelope_distance = 0.5;
    const b = computePose(arm, pose(0.2), ctx).bones.get('thigh')!;
    expect(b.deform).toBe(false);
    expect(b.envelope!.distance).toBe(0.5);
    // the same values in a new object: still read from the bone the armature holds
    arm.bones[2] = { ...arm.bones[2], use_deform: true };
    expect(computePose(arm, pose(0.2), ctx).bones.get('thigh')!.deform).toBe(true);
  });

  it('hand out rest frames of their own: changing one changes no later evaluation', () => {
    const arm = rig();
    const before = fresh(arm, pose(0.5));
    const a = computePose(arm, pose(0.5), ctx);
    for (const b of a.bones.values()) {
      b.rest[12] += 1;
      b.restHead![0] += 1;
      b.restTail![2] += 1;
      b.matrix[13] += 1;
    }
    const again = computePose(arm, pose(0.5), ctx);
    for (const [name, b] of before.bones) expect(again.bones.get(name), name).toEqual(b);
    // in the rest position too (the posed matrix is the rest frame there), and bone by bone
    const rest = { ...arm, pose_position: 'REST' as const };
    const r1 = computePose(rest, pose(0.5), ctx);
    r1.bones.get('hips')!.matrix[12] += 5;
    createPoseEvaluation(rest, pose(0.5), ctx).bone('hips')!.matrix[13] += 5;
    createPoseEvaluation(rest, pose(0.5), ctx).peek('hips')!.matrix[14] += 5;
    const r2 = computePose(rest, pose(0.5), ctx);
    expect(r2.bones.get('hips')!.matrix).toEqual(fresh(rest, pose(0.5)).bones.get('hips')!.matrix);
    expect(r2.bones.get('hips')!.matrix).toEqual(r2.bones.get('hips')!.rest);
  });

  it('report the problems with the bones at every evaluation, in the order they always had', () => {
    const arm = rig();
    arm.bones.push(
      bone('hips', [0, 0, 0], [0, 0, 1]),
      bone('flat', [1, 1, 1], [1, 1, 1], { parent: 'spine' }),
      bone('lost', [0, 0, 0], [0, 1, 0], { parent: 'nowhere' }),
      { ...bone('odd', [0, 0, 0], [0, 1, 0]), head: [0, Number.NaN, 0] as Vec3 },
    );
    const bad: Record<string, PoseBone> = {
      ...pose(0.1),
      flat: { ...defaultPoseBone(), rotation_euler: [0, 'x', 0] as unknown as Vec3 },
    };
    const expected = [
      'duplicate bone name "hips" ignored',
      'bone "lost": parent "nowhere" not found',
      'bone "flat" has zero length',
      'pose bone "flat" rotation_euler is not a valid vector; using [0, 0, 0]',
      'bone "odd" head is not a valid vector; using [0, 0, 0]',
    ];
    const first = computePose(arm, bad, ctx);
    expect(first.errors).toEqual(expected);
    expect(computePose(arm, bad, ctx).errors).toEqual(expected);
    expect(computePose(arm, pose(0.1), ctx).errors).toEqual(expected.filter((e) => !e.includes('pose bone')));
  });
});
