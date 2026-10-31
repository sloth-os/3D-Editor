import { test, expect } from '@playwright/test';
import { menuPath, newProject, outlinerNames, runFromPalette, statNumber } from './helpers';

test.describe('editor', () => {
  test('creates a project with the default scene and adds objects from menus', async ({ page }) => {
    await newProject(page);
    expect(await outlinerNames(page)).toEqual(expect.arrayContaining(['Camera', 'Cube', 'Light']));
    await expect(page.getByTestId('stats-vertices')).toContainText('8');
    await menuPath(page, ['Add', 'Mesh', 'UV Sphere']);
    await expect(page.getByTestId('outliner-Sphere')).toBeVisible();
    // the new object is selected and active
    await expect(page.getByTestId('outliner-Sphere')).toHaveClass(/active/);
    // Adjust Last Operation panel re-runs the operator with new parameters
    await expect(page.getByTestId('redo-panel')).toBeVisible();
    const before = await statNumber(page, 'stats-vertices');
    await page.getByTestId('redo-segments').click();
    await page.locator('[data-testid=redo-segments] input').fill('8');
    await page.keyboard.press('Enter');
    await expect.poll(() => statNumber(page, 'stats-vertices')).toBeLessThan(before);
    expect((await outlinerNames(page)).filter((n) => n.startsWith('Sphere'))).toHaveLength(1);
  });

  test('transforms with keyboard modal (G X 2 Enter), undo and redo', async ({ page }) => {
    await newProject(page);
    await page.getByTestId('outliner-Cube').click();
    const vp = page.getByTestId('viewport');
    await vp.hover();
    await page.keyboard.press('g');
    await page.keyboard.press('x');
    await page.keyboard.type('2');
    await expect(page.getByTestId('hud')).toContainText('along X');
    await page.keyboard.press('Enter');
    await page.getByTestId('prop-tab-object').click();
    await expect(page.getByTestId('loc-0')).toContainText('2 m');
    await vp.hover();
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('loc-0')).toContainText('0 m');
    await page.keyboard.press('Control+Shift+z');
    await expect(page.getByTestId('loc-0')).toContainText('2 m');
  });

  test('edits properties by typing values and renames objects', async ({ page }) => {
    await newProject(page);
    await page.getByTestId('outliner-Cube').click();
    await page.getByTestId('prop-tab-object').click();
    await page.getByTestId('loc-2').click();
    await page.locator('[data-testid=loc-2] input').fill('1.5+1');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('loc-2')).toContainText('2.5 m');
    await page.getByTestId('object-name').fill('Box');
    await page.getByTestId('object-name').press('Enter');
    await expect(page.getByTestId('outliner-Box')).toBeVisible();
  });

  test('edit mode: select all, extrude region and loop through select modes', async ({ page }) => {
    await newProject(page);
    await page.getByTestId('outliner-Cube').click();
    const vp = page.getByTestId('viewport');
    await vp.hover();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('mode-select')).toHaveValue('EDIT');
    await page.keyboard.press('3');
    await page.keyboard.press('a');
    await runFromPalette(page, 'extrude region shrink', 'Extrude Region and Shrink/Fatten');
    await expect.poll(() => statNumber(page, 'stats-vertices')).toBeGreaterThan(8);
    await vp.hover();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('mode-select')).toHaveValue('OBJECT');
  });

  test('adds a subdivision modifier from the properties editor', async ({ page }) => {
    await newProject(page);
    await page.getByTestId('outliner-Cube').click();
    await page.getByTestId('prop-tab-modifiers').click();
    await page.getByTestId('add-modifier-button').click();
    await page.locator('.menu .menu-item', { hasText: 'Generate' }).hover();
    await page.locator('.menu .menu-item', { hasText: 'Subdivision Surface' }).click();
    await expect.poll(() => statNumber(page, 'stats-vertices')).toBe(26);
    await page.getByTestId('mod-subsurf-levels').click();
    await page.locator('[data-testid=mod-subsurf-levels] input').fill('2');
    await page.keyboard.press('Enter');
    await expect.poll(() => statNumber(page, 'stats-vertices')).toBe(98);
  });

  test('renders an image (F12) and exports glTF', async ({ page }) => {
    await newProject(page);
    await page.getByTestId('viewport').hover();
    await page.keyboard.press('F12');
    await expect(page.getByTestId('render-image')).toBeVisible({ timeout: 60_000 });
    const src = await page.getByTestId('render-image').getAttribute('src');
    expect(src?.startsWith('data:image/png;base64,')).toBe(true);
    await page.keyboard.press('Escape');
    await page.locator('.modal .close').click();
    await menuPath(page, ['File', 'Export', 'glTF 2.0 (.glb)']);
    const download = page.waitForEvent('download');
    await page.getByTestId('export-confirm').click();
    const d = await download;
    expect(d.suggestedFilename()).toMatch(/\.glb$/);
    const path = await d.path();
    const fs = await import('node:fs');
    const bytes = fs.readFileSync(path!);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('glTF');
  });

  test('animation: insert keyframes and scrub the timeline', async ({ page }) => {
    await newProject(page);
    await page.getByTestId('outliner-Cube').click();
    const vp = page.getByTestId('viewport');
    await vp.hover();
    await page.keyboard.press('i');
    await page.getByTestId('current-frame').click();
    await page.locator('[data-testid=current-frame] input').fill('20');
    await page.keyboard.press('Enter');
    await page.getByTestId('prop-tab-object').click();
    await page.getByTestId('loc-0').click();
    await page.locator('[data-testid=loc-0] input').fill('4');
    await page.keyboard.press('Enter');
    // editing an animated property re-keys it at the current frame
    await expect(page.getByTestId('loc-0')).toHaveClass(/keyed/);
    await page.getByTestId('current-frame').click();
    await page.locator('[data-testid=current-frame] input').fill('10');
    await page.keyboard.press('Enter');
    const text = (await page.getByTestId('loc-0').textContent()) ?? '';
    const x = Number(text.replace(/[^\d.-]/g, ''));
    expect(x).toBeGreaterThan(0.5);
    expect(x).toBeLessThan(3.5);
    await expect(page.getByTestId('loc-0')).toHaveClass(/animated/);
  });
});
