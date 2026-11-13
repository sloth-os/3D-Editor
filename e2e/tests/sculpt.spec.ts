import { test, expect, type Page } from '@playwright/test';
import { menuPath, newProject } from './helpers';

/** Evaluates an expression in the editor's JavaScript console and returns the printed result. */
async function consoleEval(page: Page, expr: string): Promise<string> {
  await page.getByTestId('bottom-tab-console').click();
  const input = page.getByTestId('console-input');
  const before = await page.locator('.log .line').count();
  await input.fill(expr);
  await input.press('Enter');
  // echo line + result line
  await expect.poll(async () => page.locator('.log .line').count()).toBeGreaterThanOrEqual(before + 2);
  return ((await page.locator('.log .line').last().textContent()) ?? '').trim();
}

const CHECKSUM =
  "doc.getMesh(doc.findObjectByName('Sphere').data).positions.reduce((a, b) => a + Math.abs(b), 0).toFixed(3)";

test('sculpt mode: a brush stroke deforms the mesh and undo restores it', async ({ page }) => {
  await newProject(page);
  // remove the default cube so the sphere is unobstructed
  await page.getByTestId('outliner-Cube').click();
  await page.getByTestId('viewport').hover();
  await page.keyboard.press('x');
  await menuPath(page, ['Add', 'Mesh', 'UV Sphere']);
  await expect(page.getByTestId('outliner-Sphere')).toBeVisible();
  const before = await consoleEval(page, CHECKSUM);
  await page.getByTestId('mode-select').selectOption('SCULPT');
  await expect(page.getByTestId('brush-settings')).toBeVisible();
  const box = (await page.getByTestId('viewport').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 40, cy);
  await page.mouse.down();
  for (let i = 0; i <= 10; i++) await page.mouse.move(cx - 40 + i * 8, cy + Math.sin(i / 2) * 10);
  await page.mouse.up();
  await expect.poll(() => consoleEval(page, CHECKSUM)).not.toBe(before);
  // leave the console (its text field keeps keyboard focus) before using editor shortcuts
  await page.getByTestId('bottom-tab-timeline').click();
  await page.getByTestId('viewport').hover();
  await page.keyboard.press('Control+z');
  await expect.poll(() => consoleEval(page, CHECKSUM)).toBe(before);
});
