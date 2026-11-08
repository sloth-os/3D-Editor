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
