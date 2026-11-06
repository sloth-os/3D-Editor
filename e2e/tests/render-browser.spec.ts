import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  decodePng,
  decodePngDataUrl,
  imageStats,
  newProject,
  pngChunks,
  setNumberField,
  setOutputPercentage,
} from './helpers';

test.describe('rendering in the browser', () => {
  test('F12 with the path tracer renders a small image on the render workers', async ({ page }) => {
    await newProject(page);
    // 5 % of 1920×1080
    await setOutputPercentage(page, 5);
    await page.getByTestId('prop-tab-render').click();
    await expect(page.getByTestId('render-samples')).toHaveCount(0);
    await page.getByTestId('render-engine').selectOption('PATHTRACER');
    await expect(page.getByTestId('render-engine-hint')).toContainText('Physically based');
    await setNumberField(page, 'render-samples', 4);
    await expect(page.getByTestId('render-samples')).toHaveText('4');

    await page.getByTestId('viewport').hover();
    await page.keyboard.press('F12');
    await expect(page.getByTestId('render-dialog')).toContainText('Render (Path Tracer)');
    const image = page.getByTestId('render-image');
    await expect(image).toBeVisible({ timeout: 90_000 });
    const status = page.getByTestId('render-status');
    await expect(status).toContainText('Finished');
    await expect(status).toContainText('Sample 4/4');
    await expect(status).toContainText('96×54');

    // a finished picture: the lit cube on the grey studio background, not a blank frame
    const img = decodePngDataUrl((await image.getAttribute('src')) ?? '');
    expect([img.width, img.height]).toEqual([96, 54]);
    const stats = imageStats(img);
    expect(stats.mean).toBeGreaterThan(20);
    expect(stats.mean).toBeLessThan(235);
    expect(stats.std).toBeGreaterThan(10);
    expect(stats.colors).toBeGreaterThan(8);
    const opaque = img.data.filter((_, i) => i % 4 === 3).every((a) => a === 255);
    expect(opaque).toBe(true);

    // Save Image downloads that PNG
    const download = page.waitForEvent('download');
    await page.getByTestId('render-save').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.png$/);
    const saved = decodePng(readFileSync((await file.path())!));
    expect([saved.width, saved.height]).toEqual([96, 54]);
    expect(Buffer.from(saved.data).equals(Buffer.from(img.data))).toBe(true);
    await page.locator('.modal .close').click();
    await expect(page.getByTestId('render-dialog')).toHaveCount(0);

    // a long render: Esc stops sampling and keeps the picture rendered so far
    await setNumberField(page, 'render-samples', 4096);
    await page.getByTestId('viewport').hover();
    await page.keyboard.press('F12');
    await expect(status).toContainText('Path Tracing', { timeout: 60_000 });
    await expect
      .poll(async () => Number(/Sample (\d+)\//.exec((await status.textContent()) ?? '')?.[1] ?? 0), {
        timeout: 60_000,
      })
      .toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(status).toContainText('Cancelled');
    await expect(image).toBeVisible();
    const samples = Number(/Sample (\d+)\/4096/.exec((await status.textContent()) ?? '')?.[1]);
    expect(samples).toBeGreaterThan(0);
    expect(samples).toBeLessThan(4096);
    const partial = decodePngDataUrl((await image.getAttribute('src')) ?? '');
    expect([partial.width, partial.height]).toEqual([96, 54]);
    expect(imageStats(partial).std).toBeGreaterThan(10);
    await expect(page.getByTestId('render-save')).toBeVisible();
    await page.locator('.modal .close').click();
    await expect(page.getByTestId('render-dialog')).toHaveCount(0);
  });

  test('Render Animation (Ctrl+F12) encodes a few rasterized frames into an animated PNG download', async ({
    page,
  }) => {
    await newProject(page);
    await setOutputPercentage(page, 5);
    // something that moves: the cube is keyed at frames 1 and 4
    await page.getByTestId('outliner-Cube').click();
    await page.getByTestId('viewport').hover();
    await page.keyboard.press('i');
    await setNumberField(page, 'current-frame', 4);
    await page.getByTestId('prop-tab-object').click();
    await setNumberField(page, 'loc-0', 2);
    await expect(page.getByTestId('loc-0')).toHaveClass(/keyed/);

    await page.getByTestId('prop-tab-render').click();
    await expect(page.getByTestId('render-engine')).toHaveValue('RASTER');
    await page.getByTestId('viewport').hover();
    await page.keyboard.press('Control+F12');
    const settings = page.getByTestId('render-animation-settings');
    await expect(settings).toBeVisible();
    await expect(page.getByTestId('render-animation-format')).toHaveValue('APNG');
    await setNumberField(page, 'render-animation-end-frame', 4);
    await expect(settings).toContainText('4 frames · 96×54 px · 24 fps · Rasterized (WebGL)');
    await page.getByTestId('render-animation-start').click();

    await expect(page.getByTestId('render-animation-result')).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId('render-animation-info')).toContainText('4 frames (1–4) · 96×54 · 24 fps');

    const download = page.waitForEvent('download');
    await page.getByTestId('render-animation-save').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.png$/);
    const bytes = readFileSync((await file.path())!);
    const chunks = pngChunks(bytes);
    // APNG: an animation control chunk with four frames, played forever, and one fcTL per frame
    const actl = chunks.find((c) => c.type === 'acTL');
    expect(actl).toBeDefined();
    expect(actl!.data.readUInt32BE(0)).toBe(4);
    expect(actl!.data.readUInt32BE(4)).toBe(0);
    expect(chunks.filter((c) => c.type === 'fcTL')).toHaveLength(4);
    const first = decodePng(bytes);
    expect([first.width, first.height]).toEqual([96, 54]);
    expect(imageStats(first).std).toBeGreaterThan(10);
    await page.locator('.modal .close').click();
  });
});
