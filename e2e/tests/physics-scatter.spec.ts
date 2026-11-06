import { test, expect, type Page } from '@playwright/test';
import {
  PLAIN,
  callJson,
  changedFraction,
  decodePng,
  fieldNumber,
  mcpConnect,
  newProject,
  setNumberField,
  type RgbaImage,
} from './helpers';

/** A screenshot of the middle of the 3D viewport (where the default cube is), away from its overlays. */
async function viewportCentre(page: Page): Promise<RgbaImage> {
  const box = (await page.getByTestId('viewport').boundingBox())!;
  const size = 160;
  const clip = {
    x: Math.round(box.x + box.width / 2 - size / 2),
    y: Math.round(box.y + box.height / 2 - size / 2),
    width: size,
    height: size,
  };
  return decodePng(await page.screenshot({ clip }));
}

test.describe('physics and scattering', () => {
  test('rigid body from the Physics tab, baked in the Scene tab, falls as the frame changes', async ({
    page,
  }) => {
    const id = await newProject(page);
    await page.getByTestId('outliner-Cube').click();
    await page.getByTestId('prop-tab-physics').click();
    await expect(page.getByTestId('physics-rigid-body')).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('physics-rigid-body').click();
    await expect(page.getByTestId('physics-rigid-body')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('rigidbody-type-ACTIVE')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('rigidbody-status')).toHaveText(
      'At rest until the simulation starts after frame 1',
    );
    await expect(page.getByTestId('outl-badge-Cube-rigid_body')).toBeVisible();

    // bake the whole simulation range from the Scene tab
    await page.getByTestId('prop-tab-scene').click();
    const cache = page.getByTestId('scene-rigidbody-cache');
    await expect(cache).toContainText('1 rigid body (1 active) · Nothing cached yet');
    await page.getByTestId('scene-rigidbody-bake').click();
    await expect(cache).toContainText('Cached frames 1–250 of 1–250', { timeout: 60_000 });
    await expect(page.getByTestId('scene-rigidbody-bake')).toBeEnabled();

    // frame 40: the cube has fallen out of the middle of the view (there is no floor)
    const atRest = await viewportCentre(page);
    await setNumberField(page, 'current-frame', 40);
    await expect(page.getByTestId('viewport-info')).toContainText('(40)');
    await expect.poll(async () => changedFraction(atRest, await viewportCentre(page))).toBeGreaterThan(0.1);
    await page.getByTestId('prop-tab-physics').click();
    await expect(page.getByTestId('rigidbody-status')).toHaveText('Simulated at frame 40');
    // and back at the start frame it is where it was
    await setNumberField(page, 'current-frame', 1);
    await expect.poll(async () => changedFraction(atRest, await viewportCentre(page))).toBeLessThan(0.01);

    // Bake to Keyframes turns the simulated motion into keys of the location (and removes the rigid body)
    await page.getByTestId('prop-tab-scene').click();
    await page.getByTestId('scene-rigidbody-bake-keyframes').click();
    await expect(cache).toContainText('No rigid bodies');
    await expect(page.getByTestId('outl-badge-Cube-rigid_body')).toHaveCount(0);
    await page.getByTestId('prop-tab-object').click();
    await expect(page.getByTestId('loc-2')).toHaveClass(/keyed/);
    await expect(page.getByTestId('loc-2')).toHaveText(/Z\s*0 m/);
    await setNumberField(page, 'current-frame', 40);
    // free fall for 39 frames at 24 fps: about ½·9.81·1.625² ≈ 13 m
    await expect.poll(() => fieldNumber(page, 'loc-2')).toBeLessThan(-10);
    const z = await fieldNumber(page, 'loc-2');
    expect(z).toBeGreaterThan(-14);

    // the keys are in the shared document: the server evaluates the same fall
    const client = await mcpConnect(PLAIN);
    await expect
      .poll(async () => {
        const o = await callJson(client, 'get_object', { project: id, object: 'Cube', frame: 40 });
        return Math.abs(o.world_location[2] - z);
      })
      .toBeLessThan(0.002);

    // one undo step brings the rigid body back instead of the keys
    await page.getByTestId('viewport').hover();
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('outl-badge-Cube-rigid_body')).toBeVisible();
    await expect(page.getByTestId('loc-2')).not.toHaveClass(/keyed|animated/);
    await expect(page.getByTestId('loc-2')).toHaveText(/Z\s*0 m/);
    await expect
      .poll(async () => (await callJson(client, 'get_object', { project: id, object: 'Cube' })).rigid_body)
      .toMatchObject({ type: 'ACTIVE' });
    await client.close();
  });

  test('a scatter made by an agent shows its instances in the Particles tab and in get_instances', async ({
    page,
  }) => {
    const id = await newProject(page);
    const client = await mcpConnect(PLAIN);
    await callJson(client, 'add_object', {
      project: id,
      type: 'plane',
      name: 'Ground',
      params: { size: 10 },
    });
    await callJson(client, 'add_object', {
      project: id,
      type: 'ico_sphere',
      name: 'Pebble',
      params: { radius: 0.1 },
      location: [0, 0, -5],
    });
    const scatter = await callJson(client, 'run_operator', {
      project: id,
      operator: 'object.scatter_add',
      params: { surface: 'Ground', objects: ['Pebble'], count: 25, seed: 3 },
    });
    expect(scatter.result).toMatchObject({ name: 'Scatter', particles: 25, instances: 25, errors: [] });

    await expect(page.getByTestId('outl-badge-Ground-particles')).toBeVisible();
    await page.getByTestId('outliner-Ground').click();
    await page.getByTestId('prop-tab-particles').click();
    await expect(page.getByTestId('psys-Scatter')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('psys-Scatter-stats')).toHaveText('25 instances in the viewport');

    // more particles from the panel
    await setNumberField(page, 'psys-Scatter-count', 40);
    await expect(page.getByTestId('psys-Scatter-stats')).toHaveText('40 instances in the viewport');
    type Instances = {
      total: number;
      particle_systems: { name: string; instance_object: string; instances: number; shown?: boolean }[];
      instances: { system: string; source: string; location: number[]; scale: number[] }[];
      truncated?: boolean;
      next?: { offset: number };
    };
    await expect
      .poll(
        async () =>
          (await callJson<Instances>(client, 'get_instances', { project: id, object: 'Ground' })).total,
      )
      .toBe(40);
    const all = await callJson<Instances>(client, 'get_instances', { project: id, object: 'Ground' });
    expect(all.particle_systems).toEqual([
      expect.objectContaining({ name: 'Scatter', instance_object: 'Pebble', instances: 40 }),
    ]);
    expect(all.instances).toHaveLength(40);
    for (const inst of all.instances) {
      expect(inst).toMatchObject({ system: 'Scatter', source: 'Pebble', scale: [1, 1, 1] });
      // on the 10 m plane
      expect(Math.abs(inst.location[0])).toBeLessThanOrEqual(5);
      expect(Math.abs(inst.location[1])).toBeLessThanOrEqual(5);
      expect(inst.location[2]).toBeCloseTo(0, 4);
    }
    // paged
    const page1 = await callJson<Instances>(client, 'get_instances', {
      project: id,
      object: 'Ground',
      limit: 15,
    });
    expect(page1.instances).toHaveLength(15);
    expect(page1.truncated).toBe(true);
    expect(page1.next).toEqual({ offset: 15 });
    const page3 = await callJson<Instances>(client, 'get_instances', {
      project: id,
      object: 'Ground',
      offset: 30,
      limit: 15,
    });
    expect(page3.instances).toEqual(all.instances.slice(30));

    // hidden in the viewport from the list: renders still have them
    await page.getByTestId('psys-Scatter-viewport').click();
    await expect(page.getByTestId('psys-Scatter-stats')).toHaveText('Hidden in the viewport');
    await expect
      .poll(
        async () =>
          (
            await callJson<Instances>(client, 'get_instances', {
              project: id,
              object: 'Ground',
              source: 'VIEWPORT',
            })
          ).total,
      )
      .toBe(0);
    expect(
      (await callJson<Instances>(client, 'get_instances', { project: id, object: 'Ground' })).total,
    ).toBe(40);
    await client.close();
  });
});
