import { test, expect, type Page } from '@playwright/test';
import {
  PLAIN,
  callJson,
  changedFraction,
  imageStats,
  mcpConnect,
  newProject,
  region,
  renderStill,
  setNumberField,
  setOutputPercentage,
  type RgbaImage,
} from './helpers';

/** The middle of the camera view, where the default cube is. */
const centre = (img: RgbaImage) => region(img, 0.45, 0.42, 0.1, 0.16);
/** The top rows of the image: background only. */
const top = (img: RgbaImage) => region(img, 0, 0, 1, 0.1);

async function openPanel(page: Page, title: string): Promise<void> {
  await page.locator('.panel-header', { hasText: title }).click();
}

test.describe('materials and world', () => {
  test('material preset grid (Gold) and a procedural texture on the base colour', async ({ page }) => {
    const id = await newProject(page);
    await setOutputPercentage(page, 5);
    const plain = await renderStill(page);
    expect([plain.width, plain.height]).toEqual([96, 54]);

    await page.getByTestId('outliner-Cube').click();
    await page.getByTestId('prop-tab-material').click();
    await expect(page.getByTestId('material-slot-0')).toContainText('Material');
    // the preset panel starts closed when the slot has a material
    await expect(page.getByTestId('material-presets')).toHaveCount(0);
    await openPanel(page, 'Presets');
    const presets = page.getByTestId('material-presets').getByRole('option');
    await expect(presets.first()).toBeVisible();
    expect(await presets.count()).toBeGreaterThanOrEqual(30);
    await page.getByTestId('material-preset-gold').click();
    await expect(page.getByTestId('material-preset-gold')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('material-preset-description')).toContainText('Gold (Metal)');
    await page.getByTestId('material-preset-new').click();
    await expect(page.getByTestId('material-slot-0')).toContainText('Gold');
    await expect(page.getByTestId('material-metallic')).toHaveText('1');
    await expect(page.getByTestId('material-roughness')).toHaveText('0.18');

    const client = await mcpConnect(PLAIN);
    await expect
      .poll(async () => (await callJson(client, 'get_object', { project: id, object: 'Cube' })).materials[0])
      .toMatchObject({ slot: 0, material: { name: 'Gold', metallic: 1, roughness: 0.18 } });

    // the render shows a gold cube: other pixels, warm (red over blue)
    const gold = await renderStill(page);
    expect(changedFraction(plain, gold, centre(gold))).toBeGreaterThan(0.9);
    const goldStats = imageStats(gold, centre(gold));
    expect(goldStats.rgb[0] - goldStats.rgb[2]).toBeGreaterThan(8);

    // a procedural checker on the base colour (Textures panel)
    await expect(page.getByTestId('tex-base_color-source-NONE')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('tex-base_color-source-PROCEDURAL').click();
    await expect(page.getByTestId('tex-base_color-procedural')).toBeVisible();
    await expect(page.getByTestId('tex-base_color-type')).toHaveValue('NOISE');
    await page.getByTestId('tex-base_color-type').selectOption('CHECKER');
    await setNumberField(page, 'tex-base_color-scale', 4);
    await expect
      .poll(
        async () =>
          (await callJson(client, 'get_object', { project: id, object: 'Cube' })).materials[0].material
            .textures.base_color?.procedural,
      )
      .toMatchObject({ type: 'CHECKER', scale: 4 });

    // black and white squares: dark pixels and contrast where the cube was evenly gold
    const checker = await renderStill(page);
    const checkerStats = imageStats(checker, centre(checker));
    expect(checkerStats.dark).toBeGreaterThan(0.15);
    expect(checkerStats.std).toBeGreaterThan(goldStats.std + 8);
    await client.close();
  });

  test('world: a Sky preset and mist', async ({ page }) => {
    const id = await newProject(page);
    await setOutputPercentage(page, 5);
    const studio = await renderStill(page);

    await page.getByTestId('prop-tab-world').click();
    await expect(page.getByTestId('world-environment')).toHaveValue('STUDIO');
    await expect(page.getByTestId('world-sky-preset')).toHaveCount(0);
    await page.getByTestId('world-environment').selectOption('SKY');
    await expect(page.getByTestId('world-sky-preset')).toBeVisible();
    await page.getByTestId('world-sky-preset').selectOption('SUNSET');
    // the preset sets a low sun
    await expect(page.getByTestId('world-sun-elevation')).toHaveText('2°');
    await expect(page.getByTestId('world-show-background')).toHaveClass(/on/);

    // the sky dome replaces the grey studio behind the cube (the camera looks down: the top of the
    // frame shows the sky's warm ground colour, below the horizon)
    const sunset = await renderStill(page);
    const grey = imageStats(studio, top(studio));
    expect(Math.abs(grey.rgb[0] - grey.rgb[2])).toBeLessThan(4);
    expect(changedFraction(studio, sunset, top(sunset), 15)).toBeGreaterThan(0.8);
    const sky = imageStats(sunset, top(sunset));
    expect(sky.rgb[0] - sky.rgb[2]).toBeGreaterThan(10);

    // mist reaching 95 % at 20 m (the Mist panel starts closed while there is none)
    await expect(page.getByTestId('world-mist-distance')).toHaveCount(0);
    await openPanel(page, 'Mist');
    await expect(page.getByTestId('world-mist-distance')).toHaveText('Off');
    await setNumberField(page, 'world-mist-distance', 20);
    await expect(page.getByTestId('world-mist-distance')).toHaveText('20 m');
    await expect(page.getByTestId('world-mist-density')).toHaveText('0.0865 /m');

    const client = await mcpConnect(PLAIN);
    await expect
      .poll(async () => (await callJson(client, 'get_scene', { project: id })).world)
      .toMatchObject({ environment: 'SKY', mist_density: 0.08654, sky: { sun_elevation: 0.0349 } });

    // the cube, about 11 m from the camera, fades into the mist; the sky is not fogged
    const misty = await renderStill(page);
    expect(changedFraction(sunset, misty, centre(misty))).toBeGreaterThan(0.5);
    expect(changedFraction(sunset, misty, top(misty), 6)).toBeLessThan(0.02);
    await client.close();
  });
});
