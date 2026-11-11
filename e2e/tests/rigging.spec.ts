import { test, expect } from '@playwright/test';
import {
  PLAIN,
  callJson,
  changedFraction,
  fieldNumber,
  mcpConnect,
  menuPath,
  newProject,
  region,
  setNumberField,
  viewportPictures,
  viewportShot,
  type RgbaImage,
} from './helpers';

type Vec3 = [number, number, number];
interface BoneInfo {
  name: string;
  parent: string | null;
  head: Vec3;
  tail: Vec3;
  posed_head_world: Vec3;
  posed_tail_world: Vec3;
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Share of the viewport above the default cube (where the bones above its top, 1 m high, are drawn
 * in the default view) that differs from `before`.
 */
const bonesChange = (before: RgbaImage, now: RgbaImage) =>
  changedFraction(before, now, region(now, 0.45, 0.25, 0.12, 0.235));

test.describe('rigging', () => {
  test('armature: bones list, an IK chain and posing, with an agent editing the same rig live', async ({
    page,
  }) => {
    const id = await newProject(page);
    const client = await mcpConnect(PLAIN);
    const bones = async () =>
      (await callJson(client, 'get_object', { project: id, object: 'Armature' })).data.bones as BoneInfo[];
    const bone = async (name: string) => (await bones()).find((b) => b.name === name)!;

    await menuPath(page, ['Add', 'Armature']);
    await expect(page.getByTestId('outliner-Armature')).toHaveClass(/active/);
    await page.getByTestId('prop-tab-data').click();
    const list = page.getByTestId('bones');
    await expect(list.getByRole('option')).toHaveText(['Bone']);
    await expect(page.getByTestId('bone-tail-2')).toContainText('1 m');

    // a child bone from the list's + button (it continues the active bone and becomes active)
    await page.getByTestId('bone-add').click();
    await expect(list.getByRole('option')).toHaveText(['Bone', 'Bone.001']);
    await expect(page.getByTestId('bone-Bone.001')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('bone-parent')).toHaveValue('Bone');

    // an agent adds a third bone and an IK target: the open panel shows them without a reload
    await callJson(client, 'run_operator', {
      project: id,
      operator: 'armature.bone_add',
      params: { object: 'Armature', name: 'Hand', parent: 'Bone.001', length: 0.5 },
    });
    await expect(list.getByRole('option')).toHaveText(['Bone', 'Bone.001', 'Hand']);
    await callJson(client, 'add_object', {
      project: id,
      type: 'empty',
      name: 'IKTarget',
      location: [1, 0, 1.6],
    });
    await expect(page.getByTestId('outliner-IKTarget')).toBeVisible();
    await expect.poll(async () => (await bone('Hand'))?.posed_tail_world).toEqual([0, 0, 2.5]);

    // the agent's add_object made its own selection, not ours: the armature is still active here
    await expect(page.getByTestId('outliner-Armature')).toHaveClass(/active/);
    await page.getByTestId('bone-Hand').click();
    await expect(page.locator('.panel-header', { hasText: 'Pose: Hand' })).toBeVisible();
    const straight = await viewportShot(page);
    await expect(page.getByTestId('pose-ik-target').locator('option')).toContainText(['IKTarget']);
    await page.getByTestId('pose-ik-target').selectOption({ label: 'IKTarget' });
    await expect(page.getByTestId('pose-ik-chain')).toContainText('2');
    await page.getByTestId('pose-ik-add').click();
    const ik = page.getByTestId('bone-constraint-IK');
    await expect(ik).toContainText('Target: IKTarget');
    await expect(page.getByTestId('bone-constraint-IK-chain')).toContainText('2');

    // the two-bone chain bends to reach the target; the root bone (outside the chain) stays put
    await expect
      .poll(async () => dist((await bone('Hand')).posed_tail_world, [1, 0, 1.6]))
      .toBeLessThan(0.01);
    expect((await bone('Bone')).posed_tail_world).toEqual([0, 0, 1]);
    expect((await bone('Bone.001')).posed_head_world).toEqual([0, 0, 1]);
    // the viewport draws the bent chain
    await expect.poll(async () => bonesChange(straight, await viewportShot(page))).toBeGreaterThan(0.01);

    // pose the root bone in the Pose panel: 30° about its X axis tilts the whole chain
    await page.getByTestId('bone-Bone').click();
    await expect(page.locator('.panel-header', { hasText: 'Pose: Bone' })).toBeVisible();
    const rest = await viewportShot(page);
    await setNumberField(page, 'pose-rotation-0', 30);
    await expect(page.getByTestId('pose-rotation-0')).toContainText('30°');
    await expect
      .poll(async () => dist((await bone('Bone')).posed_tail_world, [0, -0.5, 0.866]))
      .toBeLessThan(0.002);
    await expect.poll(async () => bonesChange(rest, await viewportShot(page))).toBeGreaterThan(0.01);
    // the IK chain follows its new root and still reaches the target
    expect(dist((await bone('Bone.001')).posed_head_world, [0, -0.5, 0.866])).toBeLessThan(0.002);
    expect(dist((await bone('Hand')).posed_tail_world, [1, 0, 1.6])).toBeLessThan(0.01);

    // an agent poses the same bone: the open Pose panel shows the new rotation
    await callJson(client, 'run_operator', {
      project: id,
      operator: 'pose.bone_transform_set',
      params: { object: 'Armature', bone: 'Bone', rotation_euler: [0, 0, 0.5] },
    });
    await expect.poll(() => fieldNumber(page, 'pose-rotation-0')).toBe(0);
    await expect.poll(() => fieldNumber(page, 'pose-rotation-2')).toBeCloseTo(28.648, 2);

    // Clear Transform puts the root bone back to its rest pose: pictures of the cleared, rotated and
    // cleared bone drawn with the same multisampling (a busy machine can turn it off between
    // pictures, and edges then differ)
    const clear = async () => {
      await page.getByTestId('pose-clear').click();
      await expect.poll(() => fieldNumber(page, 'pose-rotation-2')).toBe(0);
      await expect.poll(() => fieldNumber(page, 'pose-rotation-0')).toBe(0);
      await expect.poll(async () => (await bone('Bone')).posed_tail_world).toEqual([0, 0, 1]);
    };
    const tilt = async () => {
      await setNumberField(page, 'pose-rotation-0', 30);
      await expect
        .poll(async () => dist((await bone('Bone')).posed_tail_world, [0, -0.5, 0.866]))
        .toBeLessThan(0.002);
    };
    const [cleared, tilted, clearedAgain] = await viewportPictures(page, [clear, tilt, clear]);
    expect(bonesChange(cleared, tilted)).toBeGreaterThan(0.01);
    expect(bonesChange(cleared, clearedAgain)).toBeLessThan(0.001);
    // as before it was posed
    if (rest.samples === cleared.samples) expect(bonesChange(rest, cleared)).toBeLessThan(0.001);
    await client.close();
  });
});
