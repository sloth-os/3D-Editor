import { test, expect } from '@playwright/test';
import { PLAIN, menuPath, newProject } from './helpers';

test.describe('observability', () => {
  test('browser telemetry reaches the server metrics endpoint', async ({ page, request }) => {
    await newProject(page);
    await menuPath(page, ['Add', 'Mesh', 'Cube']);
    await expect(page.getByTestId('outliner-Cube.001')).toBeVisible();
    // flush telemetry now instead of waiting for the batch interval
    await page.evaluate(() =>
      (
        window as unknown as { __editor: { telemetry: { flush(): Promise<void> } } }
      ).__editor.telemetry.flush(),
    );
    await expect
      .poll(
        async () =>
          (await (await request.get(`${PLAIN}/metrics`)).text()).includes('mesh.primitive_cube_add'),
        { timeout: 20_000 },
      )
      .toBe(true);
    const metrics = await (await request.get(`${PLAIN}/metrics`)).text();
    expect(metrics).toMatch(/editor_operator_executions_total\{[^}]*operator="mesh.primitive_cube_add"/);
    expect(metrics).toContain('sync_connections');
  });

  test('health and readiness endpoints', async ({ request }) => {
    expect((await request.get(`${PLAIN}/healthz`)).ok()).toBe(true);
    expect((await request.get(`${PLAIN}/readyz`)).ok()).toBe(true);
    const cfg = await (await request.get(`${PLAIN}/api/config`)).json();
    expect(cfg.features.mcp).toBe(true);
  });
});
