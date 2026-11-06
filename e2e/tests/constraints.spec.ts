import { test, expect } from '@playwright/test';
import { PLAIN, callJson, mcpConnect, menuPath, newProject, setNumberField } from './helpers';

type Vec3 = [number, number, number];

/** A local axis of an object in world space, from its XYZ Euler rotation (R = Rz·Ry·Rx, as in Blender). */
function localAxis(rot: Vec3, axis: 'Y' | 'Z'): Vec3 {
  const [cx, cy, cz] = rot.map(Math.cos);
  const [sx, sy, sz] = rot.map(Math.sin);
  return axis === 'Z'
    ? [cz * sy * cx + sz * sx, sz * sy * cx - cz * sx, cy * cx]
    : [cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx];
}

function closeTo(a: number[], b: number[], eps = 1e-3): boolean {
  return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);
}

test.describe('object constraints', () => {
  test('a Track To constraint added in the Constraints tab aims its owner at the picked target', async ({
    page,
  }) => {
    const id = await newProject(page);
    const client = await mcpConnect(PLAIN);
    const worldTransform = async () =>
      (await callJson(client, 'get_object', { project: id, object: 'Empty' })).world_transform as {
        location: Vec3;
        rotation_euler: Vec3;
      };

    // the owner: an empty 4 m to the side of the default cube
    await menuPath(page, ['Add', 'Empty', 'Plain Axes']);
    await expect(page.getByTestId('outliner-Empty')).toHaveClass(/active/);
    await page.getByTestId('prop-tab-object').click();
    await setNumberField(page, 'loc-0', 4);
    await expect
      .poll(worldTransform)
      .toEqual(expect.objectContaining({ location: [4, 0, 0], rotation_euler: [0, 0, 0] }));

    await page.getByTestId('prop-tab-constraints').click();
    await expect(page.getByTestId('prop-content-constraints')).toContainText('No constraints');
    await page.getByTestId('add-constraint-button').click();
    await page.getByTestId('menu-track-to').click();
    const panel = page.getByTestId('constraint-Track To');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('outl-badge-Empty-constraints')).toBeVisible();
    // without a target the constraint reports an error and does nothing
    await expect(page.getByTestId('constraint-Track To-error')).toBeVisible();
    await expect(page.getByTestId('constraint-Track To-track_axis-TRACK_NEGATIVE_Z')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // the target picker lists the other objects
    const target = page.getByTestId('constraint-Track To-target');
    await expect(target.locator('option')).toHaveText(['— none —', 'Camera', 'Cube', 'Light']);
    await target.selectOption({ label: 'Cube' });
    await expect(page.getByTestId('constraint-Track To-error')).toHaveCount(0);

    // evaluated: -Z points from the empty to the cube, +Y stays up; the stored rotation is untouched
    await expect.poll(async () => (await worldTransform()).rotation_euler).not.toEqual([0, 0, 0]);
    let wt = await worldTransform();
    expect(closeTo(localAxis(wt.rotation_euler, 'Z'), [1, 0, 0])).toBe(true);
    expect(closeTo(localAxis(wt.rotation_euler, 'Y'), [0, 0, 1])).toBe(true);
    const owner = await callJson(client, 'get_object', { project: id, object: 'Empty' });
    expect(owner.rotation_euler).toEqual([0, 0, 0]);
    expect(owner.constraints).toEqual([
      expect.objectContaining({ type: 'TRACK_TO', targets: ['Cube'], influence: 1 }),
    ]);

    // picking the target is one undo step (the picker keeps the keyboard focus: leave it first)
    await target.blur();
    await page.getByTestId('viewport').hover();
    await page.keyboard.press('Control+z');
    await expect(target).toHaveValue('');
    await expect(page.getByTestId('constraint-Track To-error')).toBeVisible();
    await expect.poll(async () => (await worldTransform()).rotation_euler).toEqual([0, 0, 0]);
    await page.keyboard.press('Control+Shift+z');
    await expect(target.locator('option:checked')).toHaveText('Cube');
    await expect.poll(async () => (await worldTransform()).rotation_euler).toEqual(wt.rotation_euler);

    // the Outliner badge of the constraint opens this tab
    await page.getByTestId('prop-tab-object').click();
    await expect(panel).toHaveCount(0);
    await page.getByTestId('outl-badge-Empty-constraints').click();
    await expect(panel).toBeVisible();

    // moving the target re-aims the owner (here an agent moves it behind the empty, +Y)
    await callJson(client, 'transform_object', { project: id, object: 'Cube', location: [4, 5, 0] });
    await expect
      .poll(async () => closeTo(localAxis((await worldTransform()).rotation_euler, 'Z'), [0, -1, 0]))
      .toBe(true);

    // influence 0 turns the constraint off
    await setNumberField(page, 'constraint-Track To-influence', 0);
    await expect.poll(async () => (await worldTransform()).rotation_euler).toEqual([0, 0, 0]);
    // and muting it from the panel header does the same at full influence
    await setNumberField(page, 'constraint-Track To-influence', 1);
    await expect.poll(async () => (await worldTransform()).rotation_euler).not.toEqual([0, 0, 0]);
    await page.getByTestId('constraint-Track To-mute').click();
    await expect.poll(async () => (await worldTransform()).rotation_euler).toEqual([0, 0, 0]);
    wt = await worldTransform();
    expect(wt.location).toEqual([4, 0, 0]);
    await client.close();
  });
});
