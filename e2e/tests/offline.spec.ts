import { test, expect } from '@playwright/test';
import { PLAIN, menuPath, newProject, openProject } from './helpers';

test.describe('offline PWA', () => {
  test('installs a service worker, works offline and syncs when back online', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const id = await newProject(page);
    // manifest + service worker
    const manifest = await page.evaluate(
      () => (document.querySelector('link[rel=manifest]') as HTMLLinkElement | null)?.href ?? null,
    );
    expect(manifest).toContain('manifest.webmanifest');
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active, null, {
      timeout: 30_000,
    });
    // make sure the SW controls the page (reload once)
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30_000 });

    // go offline: the app shell must load from the cache and the project from IndexedDB
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('viewport')).toBeVisible();
    await expect(page.getByTestId('outliner-Cube')).toBeVisible();
    await expect(page.getByTestId('sync-status')).not.toHaveAttribute('data-status', 'connected');
    await menuPath(page, ['Add', 'Mesh', 'Ico Sphere']);
    await expect(page.getByTestId('outliner-Icosphere')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('outliner-Icosphere')).toBeVisible();

    // back online: the offline edit reaches the server and other devices
    await context.setOffline(false);
    await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'connected', {
      timeout: 40_000,
    });
    const other = await (await browser.newContext()).newPage();
    await openProject(other, PLAIN, id);
    await expect(other.getByTestId('outliner-Icosphere')).toBeVisible();
    await context.close();
  });
});
