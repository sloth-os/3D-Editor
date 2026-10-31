import { test, expect } from '@playwright/test';
import { DAV_SERVER, PLAIN, WEBDAV, davGet, menuPath, newProject } from './helpers';

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

  test('saves directly to a WebDAV server configured in preferences', async ({ page }) => {
    await page.goto(`${PLAIN}/`);
    await page.getByTestId('open-preferences').click();
    await page.getByTestId('storage-mode').selectOption('webdav');
    await page.getByTestId('webdav-url').fill(WEBDAV.url);
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
    await expect(page.getByTestId('storage-status')).toHaveAttribute('data-status', 'synced', {
      timeout: 30_000,
    });
    await expect.poll(async () => (await davGet(`/direct/projects/${id}/document.ybin`)).status).toBe(200);
  });
});
