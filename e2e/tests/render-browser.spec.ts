import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  changedFraction,
  decodeApng,
  decodePng,
  decodePngDataUrl,
  imageStats,
  newProject,
  renderStill,
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

    // it ran on the render workers, one per core (at most 8), still running after the render: a
    // pool whose workers cannot start renders on the main thread instead, as "1 thread"
    const cores = await page.evaluate(() => navigator.hardwareConcurrency);
    const threads = Math.max(1, Math.min(8, Math.floor(cores) || 4));
    const renderWorkers = () =>
      page.workers().filter((w) => /\/render\.worker-[\w-]+\.js$/.test(w.url())).length;
    await expect.poll(renderWorkers).toBe(threads);
    await expect(status).toContainText(/\| [1-8] threads? \|/);

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
    // every worker renders bands of this image
    await expect(status).toContainText(`| ${threads} thread${threads === 1 ? '' : 's'} |`);
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

  test('F12 with the path tracer does not start a render that does not fit into the memory of the tab', async ({
    page,
  }) => {
    // a device that reports 0.25 GB: a render may use half of it, less than a path traced
    // 1920×1080 image needs (its film, preview and denoising)
    await page.addInitScript(() =>
      Object.defineProperty(navigator, 'deviceMemory', { value: 0.25, configurable: true }),
    );
    await newProject(page);
    await page.getByTestId('prop-tab-render').click();
    await page.getByTestId('render-engine').selectOption('PATHTRACER');
    await page.getByTestId('viewport').hover();
    await page.keyboard.press('F12');
    const dialog = page.getByTestId('render-dialog');
    await expect(dialog.locator('.error-text')).toHaveText(
      /^Path tracing was not started: it needs about \d+\.\d GB of memory with one render thread, more than the 0\.1 GB a render may use in this tab \(half the device memory the browser reports, 0\.25 GB, at most 4\.0 GB\) \(about 12 triangles, 2,073,600 pixels\), and running out of memory would end the tab\. Lower the resolution/,
    );
    await expect(page.getByTestId('render-status')).toContainText('Failed');
    // refused before any render worker started
    expect(page.workers().filter((w) => /\/render\.worker-[\w-]+\.js$/.test(w.url()))).toHaveLength(0);
    // the tab keeps working
    await page.locator('.modal .close').click();
    await expect(page.getByTestId('render-dialog')).toHaveCount(0);
    await expect(page.getByTestId('outliner-Cube')).toBeVisible();
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
    // APNG: an animation control chunk with four frames, played forever, and one fcTL per frame
    const apng = decodeApng(readFileSync((await file.path())!));
    expect([apng.frameCount, apng.plays, apng.frames.length]).toEqual([4, 0, 4]);
    const frames = apng.frames;
    expect([frames[0].width, frames[0].height]).toEqual([96, 54]);
    expect(frames[0].region).toEqual({ x: 0, y: 0, w: 96, h: 54 });
    expect(imageStats(frames[0]).std).toBeGreaterThan(10);
    // the cube moves in every frame: each later frame redraws more than the 1×1 rectangle of an
    // unchanged frame, and the picture differs from the frame before
    for (let k = 1; k < frames.length; k++) {
      const { w, h } = frames[k].region;
      expect(w * h, `area redrawn by frame ${k + 1}`).toBeGreaterThan(1);
      expect(changedFraction(frames[k - 1], frames[k]), `frame ${k + 1} against frame ${k}`).toBeGreaterThan(
        0.03,
      );
    }
    await page.locator('.modal .close').click();
    await expect(page.getByTestId('render-animation-dialog')).toHaveCount(0);

    // and every frame shows its own moment: the last and first frames are the pictures that F12
    // renders at frames 4 (the current frame) and 1
    expect(changedFraction(await renderStill(page), frames[3])).toBeLessThan(0.01);
    await setNumberField(page, 'current-frame', 1);
    expect(changedFraction(await renderStill(page), frames[0])).toBeLessThan(0.01);
  });
});
