import { test, expect } from '@playwright/test';
import { DAV_SERVER, PLAIN, WEBDAV, davAuthHeader, davGet, menuPath, newProject } from './helpers';

test.describe('WebDAV storage', () => {
  test('saves through the server WebDAV proxy and loads on a fresh device', async ({ browser }) => {
    const deviceA = await browser.newContext();
    const a = await deviceA.newPage();
    const id = await newProject(a, DAV_SERVER);
    await expect(a.getByTestId('storage-status')).toHaveAttribute('data-status', 'synced', {
      timeout: 30_000,
    });
    await menuPath(a, ['Add', 'Mesh', 'Cylinder']);
    await expect(a.getByTestId('outliner-Cylinder')).toBeVisible();
    // the real WebDAV server holds the project document and metadata
    await expect
      .poll(async () => (await davGet(`/3d-editor/projects/${id}/document.ybin`)).status, { timeout: 30_000 })
      .toBe(200);
    const info = await (await davGet(`/3d-editor/projects/${id}/project.json`)).json();
    expect(info.id).toBe(id);

    // a brand-new device (empty browser storage) lists and opens it from WebDAV
    const deviceB = await browser.newContext();
    const b = await deviceB.newPage();
    await b.goto(`${DAV_SERVER}/`);
    await expect(b.locator(`[data-testid^="project-card-"]`).first()).toBeVisible({ timeout: 20_000 });
    await b.goto(`${DAV_SERVER}/?project=${id}`);
    await expect(b.getByTestId('outliner-Cylinder')).toBeVisible({ timeout: 30_000 });
    await deviceA.close();
    await deviceB.close();
  });

  /*
   * WebDAV through the server is the server's storage. A deletion on the server was told twice (the
   * server's message, then WebDAV's 'deleted from WebDAV on another device'), and after a change
   * stored the project there again, which the server then opened again, the page stayed
   * disconnected from the server until a reload or Save.
   */
  test('says once that the server deleted a project, and syncs live again once a change stores it again', async ({
    page,
  }) => {
    const id = await newProject(page, DAV_SERVER);
    const storage = page.getByTestId('storage-status');
    const sync = page.getByTestId('sync-status');
    await expect(storage).toHaveAttribute('data-status', 'synced', { timeout: 30_000 });
    await expect(sync).toHaveAttribute('data-status', 'connected');
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
    const deleted =
      '"Untitled" was deleted on the server. This browser keeps its copy and stores it on the server again when you change it or save (Ctrl+S).';
    expect((await fetch(`${DAV_SERVER}/api/projects/${id}`, { method: 'DELETE' })).status).toBe(204);
    await expect(sync).toHaveAttribute('data-status', 'deleted');
    await expect.poll(toastLog).toEqual([deleted]);
    // WebDAV's next sync finds the deletion, and nothing more is said
    await page.evaluate(() => window.dispatchEvent(new Event('online'))); // syncs now
    await expect(storage).toHaveAttribute('data-status', 'deleted');
    expect((await fetch(`${DAV_SERVER}/api/projects/${id}`)).status).toBe(404);
    // a change stores it again through the proxy, the server opens it again, and the page syncs live
    await menuPath(page, ['Add', 'Mesh', 'Torus']);
    await expect(storage).toHaveAttribute('data-status', 'synced');
    await expect(sync).toHaveAttribute('data-status', 'connected');
    expect(await toastLog()).toEqual([
      deleted,
      '"Untitled" was deleted on the server; this browser stored it there again.',
    ]);
    await expect
      .poll(async () => (await (await fetch(`${DAV_SERVER}/api/projects/${id}`)).json()).peers)
      .toBe(1);
  });

  // webdav-server as it is (ETags only in PROPFIND, If-Match ignored: the client pairs ETags from
  // PROPFIND and reads its writes back), and under /nc like Nextcloud (ETags with GET and PUT,
  // If-Match checked: the client checks and confirms its writes with HEAD)
  for (const [server, prefix] of [
    ['webdav-server', ''],
    ['like Nextcloud', '/nc'],
  ] as const) {
    test(`saves directly to a WebDAV server configured in preferences (${server})`, async ({ page }) => {
      await page.goto(`${PLAIN}/`);
      await page.getByTestId('open-preferences').click();
      await page.getByTestId('storage-mode').selectOption('webdav');
      await page.getByTestId('webdav-url').fill(`${WEBDAV.url}${prefix}`);
      await page.getByTestId('webdav-url').press('Enter');
      await page.getByTestId('webdav-username').fill(WEBDAV.username);
      await page.getByTestId('webdav-username').press('Enter');
      await page.getByTestId('webdav-password').fill(WEBDAV.password);
      await page.getByTestId('webdav-password').press('Enter');
      await page.getByTestId('webdav-base').fill('/direct');
      await page.getByTestId('webdav-base').press('Enter');
      await page.getByTestId('webdav-test').click();
      await expect(page.getByTestId('webdav-test-result')).toContainText('Connected');
      await expect(page.getByTestId('storage-target')).toContainText('127.0.0.1:4199');
      await page.locator('.modal .close').click();
      await page.getByTestId('new-project').click();
      await expect(page.getByTestId('viewport')).toBeVisible();
      await page.waitForFunction(() => new URL(location.href).searchParams.has('project'));
      const id = new URL(page.url()).searchParams.get('project')!;
      const status = page.getByTestId('storage-status');
      await expect(status).toHaveAttribute('data-status', 'synced', { timeout: 30_000 });
      const doc = `${prefix}/direct/projects/${id}/document.ybin`;
      await expect.poll(async () => (await davGet(doc)).status).toBe(200);
      if (prefix) expect((await davGet(doc)).headers.get('ETag')).toMatch(/^"w\d+"$/);

      // another device deletes the project: without changes since its last sync, this browser
      // does not store it again (it used to at its next sync), and says so
      const del = await fetch(`${WEBDAV.url}${prefix}/direct/projects/${id}/`, {
        method: 'DELETE',
        headers: { Authorization: davAuthHeader() },
      });
      expect(del.ok).toBe(true);
      await page.evaluate(() => window.dispatchEvent(new Event('online'))); // syncs now
      await expect(status).toHaveAttribute('data-status', 'deleted');
      await expect(page.getByText('was deleted from WebDAV on another device')).toBeVisible();
      expect((await davGet(doc)).status).toBe(404);
      // Save (Ctrl+S) stores it again
      await page.getByTestId('viewport').hover();
      await page.keyboard.press('Control+s');
      await expect(status).toHaveAttribute('data-status', 'synced');
      expect((await davGet(doc)).status).toBe(200);

      // another tab of this browser deletes it: this tab, without changes since, does not store
      // it again (it used to, as a project this browser had never synced)
      const other = await page.context().newPage();
      await other.goto(`${PLAIN}/`);
      // (other tests' projects on the server have the same name)
      const card = other.getByTestId('project-card-Untitled').filter({ has: other.locator('.badge.webdav') });
      await expect(card).toBeVisible();
      other.once('dialog', (dialog) => void dialog.accept());
      await card.getByTestId('delete-project-Untitled').click();
      await expect.poll(async () => (await davGet(doc)).status).toBe(404);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await expect(status).toHaveAttribute('data-status', 'deleted');
      expect((await davGet(doc)).status).toBe(404);
      await expect(page.getByText('was deleted from WebDAV in this browser')).toBeVisible();
    });
  }
});
