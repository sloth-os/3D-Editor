import { test, expect } from '@playwright/test';
import { PLAIN, menuPath, newProject, openProject } from './helpers';

test.describe('multi-device real-time sync', () => {
  test('changes on one device appear live on another, with presence', async ({ browser }) => {
    // two independent browser contexts = two devices (separate storage)
    const deviceA = await browser.newContext();
    const deviceB = await browser.newContext();
    const a = await deviceA.newPage();
    const b = await deviceB.newPage();
    const id = await newProject(a);
    await expect(a.getByTestId('sync-status')).toHaveAttribute('data-status', 'connected');
    await openProject(b, PLAIN, id);
    await expect(b.getByTestId('outliner-Cube')).toBeVisible();
    // presence: each device sees the other
    await expect(a.getByTestId('peer-avatar')).toHaveCount(1);
    await expect(b.getByTestId('peer-avatar')).toHaveCount(1);
    // A adds an object → B sees it
    await menuPath(a, ['Add', 'Mesh', 'Torus']);
    await expect(b.getByTestId('outliner-Torus')).toBeVisible();
    // B renames → A sees it
    await b.getByTestId('outliner-Torus').dblclick();
    await b.locator('.outliner-row input').fill('Donut');
    await b.keyboard.press('Enter');
    await expect(a.getByTestId('outliner-Donut')).toBeVisible();
    // undo on A only undoes A's own change (the torus), B's rename was on that object
    await a.getByTestId('viewport').hover();
    await a.keyboard.press('Control+z');
    await expect(b.getByTestId('outliner-Donut')).toHaveCount(0);
    await deviceA.close();
    await deviceB.close();
  });

  /*
   * The server closes the connections of a project deleted there with code 4404, and new ones the
   * same way: the page used to connect again and again ('Connecting…') without saying why.
   */
  test('a page whose project is deleted on the server says so and stops connecting', async ({ page }) => {
    const id = await newProject(page);
    const status = page.getByTestId('sync-status');
    await expect(status).toHaveAttribute('data-status', 'connected');
    // every toast the page shows, in order (a toast disappears after 10 s)
    await page.evaluate(() => {
      const w = window as unknown as { toastLog: string[] };
      w.toastLog = [];
      new MutationObserver((records) => {
        for (const r of records)
          for (const n of r.addedNodes)
            if (n instanceof HTMLElement && n.dataset.testid === 'toast')
              w.toastLog.push(n.textContent ?? '');
      }).observe(document.body, { childList: true, subtree: true });
    });
    const toastLog = () => page.evaluate(() => (window as unknown as { toastLog: string[] }).toastLog);
    let connections = 0;
    page.on('websocket', () => connections++);
    const del = await fetch(`${PLAIN}/api/projects/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    await expect(status).toHaveAttribute('data-status', 'deleted');
    await expect(page.getByText('was deleted on the server. This browser keeps its copy')).toHaveCount(1);
    // it does not connect again by itself, also when the browser comes back online
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(2000);
    expect(connections).toBe(0);
    await expect(status).toHaveAttribute('data-status', 'deleted');
    // the page keeps its copy and its edits
    await menuPath(page, ['Add', 'Mesh', 'Torus']);
    await expect(page.getByTestId('outliner-Torus')).toBeVisible();
    // Save connects again; the server closes that connection the same way, and nothing more is said
    await page.getByTestId('viewport').hover();
    await page.keyboard.press('Control+s');
    await expect.poll(() => connections).toBe(1);
    await expect(status).toHaveAttribute('data-status', 'deleted');
    await page.waitForTimeout(500);
    expect(await toastLog()).toEqual([
      '"Untitled" was deleted on the server. This browser keeps its copy and no longer syncs it with the server.',
      'Saved in this browser',
    ]);
    // a reload connects again; the server closes that connection the same way
    await page.reload();
    await expect(page.getByTestId('outliner-Torus')).toBeVisible();
    await expect(status).toHaveAttribute('data-status', 'deleted');
    await expect(page.getByText('was deleted on the server. This browser keeps its copy')).toHaveCount(1);
  });

  test('two tabs of the same browser sync without the server round trip', async ({ context }) => {
    const t1 = await context.newPage();
    const id = await newProject(t1);
    const t2 = await context.newPage();
    await openProject(t2, PLAIN, id);
    await menuPath(t2, ['Add', 'Mesh', 'Cone']);
    await expect(t1.getByTestId('outliner-Cone')).toBeVisible();
  });
});
