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

  test('two tabs of the same browser sync without the server round trip', async ({ context }) => {
    const t1 = await context.newPage();
    const id = await newProject(t1);
    const t2 = await context.newPage();
    await openProject(t2, PLAIN, id);
    await menuPath(t2, ['Add', 'Mesh', 'Cone']);
    await expect(t1.getByTestId('outliner-Cone')).toBeVisible();
  });
});
