import { test, expect, type Page } from '@playwright/test';
import { PLAIN, callJson, mcpConnect, mcpEndSession, menuPath, openProject, setNumberField } from './helpers';

/*
 * The Export Video window's server export against the real server (the window exports on this
 * device by default: browser-export.spec.ts; the server is the second choice where it can export
 * the project): a scene with two shots exported as a 160×90 draft; the window follows the job and
 * lists its files, whose MP4 links the server serves. Skipped when the server found no ffmpeg
 * (features.videoExport false), unless FFMPEG_REQUIRED=1 (CI installs ffmpeg for the e2e job): then
 * a missing ffmpeg fails the test.
 */

/** Saves a screenshot when E2E_SCREENSHOT_DIR is set (visual checks outside CI). */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

test.describe('Export Video', () => {
  test('exports two shots as a small draft and links the files', async ({ page, request }) => {
    const config = (await (await request.get(`${PLAIN}/api/config`)).json()) as {
      features: { videoExport?: boolean };
    };
    if (process.env.FFMPEG_REQUIRED === '1')
      expect(config.features.videoExport, 'FFMPEG_REQUIRED=1 but the server found no ffmpeg').toBe(true);
    else test.skip(!config.features.videoExport, 'the server found no ffmpeg');

    // a project with two shots through the scene camera, made by an agent
    const client = await mcpConnect(PLAIN);
    const project = (await callJson(client, 'create_project', { name: `Export video ${Date.now()}` }))
      .id as string;
    for (const [name, frame_start, frame_end] of [
      ['Wide', 1, 6],
      ['Close', 7, 12],
    ] as const)
      await callJson(client, 'run_operator', {
        project,
        operator: 'desk.shot_add',
        params: { name, camera: 'Camera', frame_start, frame_end, solve: false },
      });
    await mcpEndSession(client);

    await openProject(page, PLAIN, project);
    await menuPath(page, ['Render', 'Export Video…']);
    const dialog = page.getByTestId('export-video-dialog');
    await expect(dialog).toBeVisible();
    // this device is the default; the server holds the project and has ffmpeg: it is offered
    await expect(page.getByTestId('export-video-where-device')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('export-video-where-server').click();
    await expect(page.getByTestId('export-video-where-server')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('export-video-shots-all')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('export-video-resolution').selectOption('custom');
    await setNumberField(page, 'export-video-width', 160);
    await setNumberField(page, 'export-video-height', 90);
    await page.getByTestId('export-video-quality-draft').click();
    const estimate = page.getByTestId('export-video-estimate');
    await expect(estimate).toContainText('12 frames');
    await expect(estimate).toContainText('160 × 90');
    await expect(estimate).toContainText('2 shots');
    await snap(page, 'export-video-settings');

    await page.getByTestId('export-video-start').click();
    await expect(page.getByTestId('export-video-job')).toBeVisible();
    await expect(page.getByTestId('export-video-status')).toBeVisible();
    await expect(page.getByTestId('export-video-files')).toBeVisible({ timeout: 75_000 });
    await expect(page.getByTestId('export-video-status')).toContainText('Done: 12 frames');
    await expect(page.getByTestId('export-video-file-shot-01-wide.mp4')).toBeVisible();
    await expect(page.getByTestId('export-video-file-shot-02-close.mp4')).toBeVisible();
    await expect(page.getByTestId('export-video-file-manifest.json')).toBeVisible();
    await expect(page.getByTestId('export-video-preview')).toBeVisible();
    await snap(page, 'export-video-done');

    const href = await page.getByTestId('export-video-file-sequence.mp4').getAttribute('href');
    expect(href).toMatch(/\/api\/projects\/.+\/video-exports\/.+\/files\/sequence\.mp4/);
    const res = await request.get(new URL(href!, PLAIN).toString());
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('video/mp4');
    expect((await res.body()).byteLength).toBeGreaterThan(1000);

    // the export is listed among the project's recent exports
    await expect(page.locator('[data-testid^="export-video-recent-"]')).toHaveCount(1);
  });
});
