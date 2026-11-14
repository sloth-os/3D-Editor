import { test, expect, type Page } from '@playwright/test';
import { PLAIN, fieldNumber, newProject, outlinerNames } from './helpers';

/*
 * The Asset Browser (bottom tab 'assets'): a search of the built-in models finds the chair, Add
 * puts it at the 3D cursor as one undo step, a card dragged onto the viewport with the mouse (the
 * browser's own drag and drop) lands where it is dropped, and the short list asks the server only
 * for the thumbnails of the cards in view and the next row.
 */

/** Saves a screenshot when E2E_SCREENSHOT_DIR is set (visual checks outside CI). */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

/** Opens the Assets tab and searches the built-in models for `words`. */
async function searchBuiltin(page: Page, words: string): Promise<void> {
  await page.getByTestId('bottom-tab-assets').click();
  await expect(page.getByTestId('asset-browser')).toBeVisible();
  await page.getByTestId('asset-provider').selectOption('builtin');
  const search = page.getByTestId('asset-search');
  await search.fill(words);
  await search.press('Enter');
}

test.describe('Asset Browser', () => {
  test('finds the built-in chair, adds it at the 3D cursor and undoes it', async ({ page }) => {
    await newProject(page, PLAIN);
    await searchBuiltin(page, 'chair');
    const card = page.getByTestId('asset-card-builtin:chair');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('asset-licence-builtin:chair')).toHaveText('CC0');
    await expect(page.getByTestId('asset-provider-status-builtin')).toHaveAttribute('data-status', 'ok');
    const before = await outlinerNames(page);
    await page.getByTestId('asset-add-builtin:chair').click();
    await expect.poll(async () => (await outlinerNames(page)).length).toBeGreaterThan(before.length);
    const added = (await outlinerNames(page)).filter((n) => !before.includes(n));
    expect(added.some((n) => /chair/i.test(n))).toBe(true);
    await snap(page, 'assets-added');
    // one undo step takes the whole model away
    await page.getByTestId('viewport').hover();
    await page.keyboard.press('Control+z');
    await expect.poll(() => outlinerNames(page)).toEqual(before);
  });

  test('drops a card dragged with the mouse onto the viewport, where it is dropped', async ({ page }) => {
    await newProject(page, PLAIN);
    await searchBuiltin(page, 'chair');
    const card = page.getByTestId('asset-card-builtin:chair');
    await expect(card).toBeVisible();
    const before = await outlinerNames(page);
    // the browser's own drag and drop (Chromium): the card must be draggable and fill the drag's
    // data, and the viewport must accept the drag over it (dragover) for the drop to happen
    const viewport = page.getByTestId('viewport');
    const box = (await viewport.boundingBox())!;
    await card.dragTo(viewport, { targetPosition: { x: box.width * 0.3, y: box.height * 0.75 } });
    await expect.poll(async () => (await outlinerNames(page)).length).toBeGreaterThan(before.length);
    expect((await outlinerNames(page)).filter((n) => !before.includes(n)).some((n) => /chair/i.test(n))).toBe(
      true,
    );
    // it stands where it was dropped (on the ground in front of the camera), not at the 3D cursor
    // (the origin of a new project): the new chair is the active object
    await page.getByTestId('prop-tab-object').click();
    await expect
      .poll(async () => Math.hypot(await fieldNumber(page, 'loc-0'), await fieldNumber(page, 'loc-1')))
      .toBeGreaterThan(0.5);
    await snap(page, 'assets-dropped');
  });

  test('asks for the thumbnails of the cards in view and the next row only', async ({ page }) => {
    const thumbnails = new Set<string>();
    page.on('request', (r) => {
      const m = /\/api\/store\/models\/([^/?]+)\/thumbnail/.exec(r.url());
      if (m) thumbnails.add(decodeURIComponent(m[1]));
    });
    await newProject(page, PLAIN);
    await page.getByTestId('bottom-tab-assets').click();
    await page.getByTestId('asset-provider').selectOption('builtin');
    // the first page of the built-in models, laid out as rows in the short bottom area
    const cards = page.locator('[data-testid^="asset-card-"]');
    await expect(cards).toHaveCount(24);
    await expect(page.getByTestId('asset-browser')).toHaveClass(/\bshort\b/);
    const results = page.getByTestId('asset-results');
    const { clientHeight, scrollHeight } = await results.evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));
    expect(scrollHeight).toBeGreaterThan(clientHeight * 3);
    // what is in view and a box height beyond it: a few rows, not the whole page
    await expect.poll(() => thumbnails.size).toBeGreaterThan(0);
    await page.waitForTimeout(1000);
    const first = thumbnails.size;
    expect(first).toBeLessThan(24);
    // scrolled to the end, the other cards ask for theirs
    await results.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect.poll(() => thumbnails.size).toBeGreaterThan(first);
  });
});
