import { test, expect } from '@playwright/test';
import {
  fieldNumber,
  menuPath,
  newProject,
  outlinerNames,
  runFromPalette,
  setNumberField,
  statNumber,
} from './helpers';

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
    await expect(page.getByTestId('hud')).toContainText('along global X');
    await page.keyboard.press('Enter');
    await page.getByTestId('prop-tab-object').click();
    await expect(page.getByTestId('loc-0')).toContainText('2 m');
    await vp.hover();
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('loc-0')).toContainText('0 m');
    await page.keyboard.press('Control+Shift+z');
    await expect(page.getByTestId('loc-0')).toContainText('2 m');
  });

  test('number entries and the outliner rename box keep every typed key; a press elsewhere closes a popup menu', async ({
    page,
  }) => {
    await newProject(page);
    await page.getByTestId('outliner-Cube').click();
    await page.getByTestId('prop-tab-object').click();
    // key by key, as a person types (the entry selected its text again after every key: 1.5 gave 5)
    await page.getByTestId('loc-0').click();
    await expect(page.locator('[data-testid=loc-0] input')).toBeFocused();
    await page.keyboard.type('1.5', { delay: 20 });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('loc-0')).toContainText('1.5 m');
    await page.getByTestId('outliner-Cube').dblclick();
    await expect(page.locator('[data-testid=outliner-Cube] input')).toBeFocused();
    await page.keyboard.type('Crate', { delay: 20 });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('outliner-Crate')).toBeVisible();
    // a popup menu closes on a press on a top-bar menu (which keeps its presses for itself), so it is
    // not left above the window opened from there; one Escape then closes the window
    await page.getByTestId('viewport').hover();
    await page.keyboard.press('Shift+A');
    await expect(page.locator('.menu')).toHaveCount(1);
    await page.getByTestId('menu-button-edit').click();
    await page.locator('.menu .menu-item', { hasText: 'Preferences…' }).click();
    await expect(page.getByTestId('preferences-dialog')).toBeVisible();
    await expect(page.locator('.menu')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('preferences-dialog')).toHaveCount(0);
  });

  test('G X X moves along the object’s own X axis (LOCAL); a third X removes the constraint', async ({
    page,
  }) => {
    await newProject(page);
    await page.getByTestId('outliner-Cube').click();
    await page.getByTestId('prop-tab-object').click();
    await setNumberField(page, 'rot-2', 90);
    const vp = page.getByTestId('viewport');
    await vp.hover();
    await page.keyboard.press('g');
    await page.keyboard.press('x');
    await expect(page.getByTestId('hud')).toContainText('along global X');
    await page.keyboard.press('x');
    await expect(page.getByTestId('hud')).toContainText('along local X');
    await page.keyboard.type('2');
    await expect(page.getByTestId('hud')).toContainText('D: 2.0000 m  0.0000 m  0.0000 m');
    await page.keyboard.press('Enter');
    // the cube is turned 90° about Z: its own X axis is the world's Y axis
    await expect(page.getByTestId('loc-1')).toContainText('2 m');
    await expect(page.getByTestId('loc-0')).toContainText('0 m');
    await vp.hover();
    await page.keyboard.press('g');
    for (let i = 0; i < 3; i++) await page.keyboard.press('x');
    await expect(page.getByTestId('hud')).not.toContainText('along');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('hud')).toHaveCount(0);
    await expect(page.getByTestId('loc-1')).toContainText('2 m');
  });

  test('S X X scales along the object’s own X axis (LOCAL)', async ({ page }) => {
    await newProject(page);
    await page.getByTestId('outliner-Cube').click();
    await page.getByTestId('prop-tab-object').click();
    await setNumberField(page, 'rot-2', 90);
    const vp = page.getByTestId('viewport');
    await vp.hover();
    await page.keyboard.press('s');
    await page.keyboard.press('x');
    await expect(page.getByTestId('hud')).toContainText('along global X');
    await page.keyboard.press('x');
    await expect(page.getByTestId('hud')).toContainText('along local X');
    await page.keyboard.type('2');
    await expect(page.getByTestId('hud')).toContainText('Scale X: 2.0000  Y: 1.0000  Z: 1.0000');
    await page.keyboard.press('Enter');
    // the cube is turned 90° about Z: along its own X axis its X scale doubles (along the world's
    // X axis its Y scale would)
    await expect.poll(() => fieldNumber(page, 'scale-0')).toBeCloseTo(2, 3);
    await expect.poll(() => fieldNumber(page, 'scale-1')).toBeCloseTo(1, 3);
    await expect.poll(() => fieldNumber(page, 'rot-2')).toBeCloseTo(90, 3);
  });

  test('Esc closes the Projects window (Ctrl+O), also after a click inside it', async ({ page }) => {
    await newProject(page);
    const projects = page.getByTestId('projects-dialog');
    await page.keyboard.press('Control+o');
    await expect(projects).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(projects).toHaveCount(0);
    await page.keyboard.press('Control+o');
    // on the title, away from the close button
    await projects.locator('.modal-header').click({ position: { x: 12, y: 10 } });
    await page.keyboard.press('Escape');
    await expect(projects).toHaveCount(0);
    // in the name field Esc first cancels the typing, the next one closes the window
    await page.keyboard.press('Control+o');
    const name = projects.getByPlaceholder('Project name');
    await name.fill('Typed');
    await page.keyboard.press('Escape');
    await expect(name).toHaveValue('Untitled');
    await page.keyboard.press('Escape');
    await expect(projects).toHaveCount(0);
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

  test('edit mode: select the top face, extrude it and return to object mode', async ({ page }) => {
    await newProject(page);
    await page.getByTestId('outliner-Cube').click();
    const vp = page.getByTestId('viewport');
    await vp.hover();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('mode-select')).toHaveValue('EDIT');
    await page.keyboard.press('3');
    await menuPath(page, ['Select', 'Faces Facing Up']);
    await expect(page.getByTestId('viewport-stats')).toContainText('Faces 1 selected');
    await menuPath(page, ['Mesh', 'Extrude Region']);
    await expect.poll(() => statNumber(page, 'stats-vertices')).toBe(12);
    await expect(page.getByTestId('viewport-stats')).toContainText('Faces 10');
    // the operator can be re-run from the palette too
    await runFromPalette(page, 'inset', 'Inset Faces');
    await expect.poll(() => statNumber(page, 'stats-vertices')).toBe(16);
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
    // Esc closes the window once the render is done, as a click outside it does
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('render-dialog')).toHaveCount(0);
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
