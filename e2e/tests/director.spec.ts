import { test, expect, type Page } from '@playwright/test';
import { PLAIN, callJson, mcpConnect, mcpEndSession, menuPath, newProject, openProject } from './helpers';

/*
 * The Director workspace (SPEC §13) in a real browser: two actors from Add › Actor, three shots added
 * from three views, solved and checked; scrubbing the sequence strip shows each shot through its own
 * camera (the viewport's picture changes with the shot), the camera guides toggle from the header
 * and the View menu, and at phone width the Shots and Sequence tabs of the bottom area do the same.
 */

/** Saves a screenshot when E2E_SCREENSHOT_DIR is set (visual checks outside CI). */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

/** Waits for two frames the viewport drew after now. */
async function drawn(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

/** The viewport's picture (its canvas) as PNG bytes. */
async function picture(page: Page): Promise<Buffer> {
  await drawn(page);
  return page.getByTestId('viewport').locator('canvas').first().screenshot();
}

/** Clicks the sequence strip at a fraction of its width. */
async function scrubTo(page: Page, fraction: number): Promise<void> {
  const track = page.getByTestId('sequence-track');
  const box = (await track.boundingBox())!;
  await track.click({ position: { x: box.width * fraction, y: box.height / 2 } });
}

/** Adds an actor of a kind from Add › Actor and moves it along X with G X <dx> Enter. */
async function addActor(page: Page, label: string, dx: number): Promise<string> {
  await menuPath(page, ['Add', 'Actor', label]);
  // the new actor is selected: the Director column shows it
  const panel = page.getByTestId('actor-panel');
  await expect(page.getByTestId('actor-kind')).toHaveText(label);
  const title = (await panel.locator('.panel-header').first().textContent()) ?? '';
  const name = title.replace(/^.*Actor:\s*/, '').trim();
  const vp = page.getByTestId('viewport');
  await vp.hover();
  await page.keyboard.press('g');
  await page.keyboard.press('x');
  await page.keyboard.type(String(dx));
  await page.keyboard.press('Enter');
  return name;
}

test.describe('Director workspace', () => {
  test('builds a cut from three views, solves and checks it, and scrubs it through the shot cameras', async ({
    page,
  }) => {
    await newProject(page, PLAIN);
    await page.getByTestId('workspace-director').click();
    await expect(page.getByTestId('director-panel')).toBeVisible();
    await expect(page.getByTestId('sequence-strip')).toBeVisible();
    await expect(page.getByTestId('sequence-track')).toContainText('No shots in the cut yet');

    const ada = await addActor(page, 'Adult', -1.2);
    const ben = await addActor(page, 'Woman', 1.2);
    expect(ada).not.toBe(ben);
    await expect(page.getByTestId('actor-kind')).toHaveText('Woman');

    // three shots from three views; with both actors selected (A) they are the shots' subjects
    await page.getByTestId('director-tab-shots').click();
    const vp = page.getByTestId('viewport');
    for (const orbit of [[], ['Numpad4', 'Numpad4', 'Numpad4'], Array(6).fill('Numpad6')]) {
      await vp.hover();
      for (const key of orbit) await page.keyboard.press(key);
      await page.keyboard.press('a');
      await page.getByTestId('shot-add').click();
    }
    await expect(page.getByTestId('shot-row-Shot 3')).toBeVisible();
    await expect(page.getByTestId('shot-inspector')).toBeVisible();
    await expect(page.getByTestId(`shot-subject-${ada}`)).toContainText(ada);
    await snap(page, 'director-shots');

    // a wide first shot, a close-up last: each edit solves its shot's camera again
    await page.getByTestId('shot-row-Shot 1').click();
    await page.getByTestId('shot-framing').selectOption('wide');
    await page.getByTestId('shot-row-Shot 3').click();
    await page.getByTestId('shot-framing').selectOption('close_up');
    await page.getByTestId('shot-angle').selectOption('three_quarter_left');
    await expect(page.getByTestId('shot-row-Shot 3')).toContainText('Close up');
    // solve every shot's camera from its description, then check continuity
    await page.getByTestId('shot-solve-all').click();
    await page.getByTestId('shot-check').click();
    await expect(page.getByTestId('check-summary')).not.toBeEmpty();
    await snap(page, 'director-checked');

    // the sequence strip: three blocks; scrubbing follows the shots through their cameras
    await expect(page.locator('[data-testid^="sequence-block-"]')).toHaveCount(3);
    await scrubTo(page, 1 / 6);
    await expect(page.getByTestId('sequence-shot')).toHaveText('1/3 Shot 1');
    await expect(page.getByTestId('camera-frame-shot')).toHaveText('Shot 1');
    await expect(page.getByTestId('toggle-follow-shots')).toHaveAttribute('aria-pressed', 'true');
    const first = await picture(page);
    await snap(page, 'director-scrub-shot1');
    await scrubTo(page, 5 / 6);
    await expect(page.getByTestId('sequence-shot')).toHaveText('3/3 Shot 3');
    await expect(page.getByTestId('camera-frame-shot')).toHaveText('Shot 3');
    const third = await picture(page);
    await snap(page, 'director-scrub-shot3');
    expect(third.equals(first)).toBe(false);
    // back to the first shot: its picture again
    await scrubTo(page, 1 / 6);
    await expect(page.getByTestId('camera-frame-shot')).toHaveText('Shot 1');

    // the keys of the strip step through the cut
    await page.getByTestId('sequence-track').press('Shift+ArrowRight');
    await expect(page.getByTestId('sequence-shot')).toHaveText('2/3 Shot 2');

    // Play leaves the focus on its button: Space there stops the cut (the timeline does not play)
    const play = page.getByTestId('sequence-play');
    await play.click();
    await expect(play).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Space');
    await expect(play).toHaveAttribute('aria-pressed', 'false');
    const stoppedAt = await page.getByTestId('sequence-time').textContent();
    await page.waitForTimeout(600);
    await expect(page.getByTestId('sequence-time')).toHaveText(stoppedAt ?? '');
    await play.press('Space');
    await expect(play).toHaveAttribute('aria-pressed', 'true');
    await play.press('Space');
    await expect(play).toHaveAttribute('aria-pressed', 'false');

    // camera guides from the header button and from the View menu
    await page.getByTestId('toggle-camera-guides').click();
    await expect(page.getByTestId('camera-guides')).toBeVisible();
    await expect(page.getByTestId('camera-guide-action-safe')).toBeAttached();
    await snap(page, 'director-guides');
    await page.getByTestId('menu-button-view').first().click();
    await page.locator('.menu .menu-item', { hasText: 'Camera Guides' }).first().click();
    await expect(page.getByTestId('camera-guides')).toHaveCount(0);
  });

  test('works at phone width from the Shots and Sequence tabs', async ({ page }) => {
    const client = await mcpConnect(PLAIN);
    const project = (await callJson(client, 'create_project', { name: `Director phone ${Date.now()}` }))
      .id as string;
    await callJson(client, 'run_operator', {
      project,
      operator: 'desk.actor_add',
      params: { kind: 'adult', name: 'Ada', location: [-1, 0, 0] },
    });
    for (const [name, frame_start, frame_end, x] of [
      ['Wide', 1, 48, 0],
      ['Close', 49, 72, -1],
    ] as const)
      await callJson(client, 'run_operator', {
        project,
        operator: 'desk.shot_add',
        params: {
          name,
          frame_start,
          frame_end,
          solve: false,
          from_view: { position: [x, -6, 1.6], target: [x, 0, 1.2], lens_mm: 35 },
        },
      });
    await mcpEndSession(client);

    await page.setViewportSize({ width: 390, height: 844 });
    await openProject(page, PLAIN, project);
    await page.getByTestId('bottom-tab-shots').click();
    await expect(page.getByTestId('director-panel')).toBeVisible();
    await expect(page.getByTestId('shot-row-Wide')).toBeVisible();
    await page.getByTestId('shot-row-Close').click();
    await expect(page.getByTestId('shot-inspector')).toBeVisible();
    // the Shots tab opens the bottom area to about half the screen: the inspector starts on it
    const inspector = (await page.getByTestId('shot-inspector').boundingBox())!;
    expect(inspector.y + 40).toBeLessThan(844);
    await snap(page, 'director-phone-shots');

    await page.getByTestId('bottom-tab-sequence').click();
    await expect(page.getByTestId('sequence-strip')).toBeVisible();
    await scrubTo(page, 0.9);
    await expect(page.getByTestId('sequence-shot')).toHaveText('2/2 Close');
    await expect(page.getByTestId('camera-frame-shot')).toHaveText('Close');
    await snap(page, 'director-phone-sequence');
    // nothing wider than the phone
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    // turned to landscape (wider than a phone) with the Shots tab open: its button is hidden then,
    // and the Shots tab gives way to the workspace's own tab (the Timeline in Layout)
    await page.getByTestId('bottom-tab-shots').click();
    await expect(page.getByTestId('director-panel')).toBeVisible();
    await page.setViewportSize({ width: 1133, height: 744 });
    await expect(page.getByTestId('bottom-tab-timeline')).toHaveClass(/\bopen\b/);
    await expect(page.getByTestId('bottom-tab-shots')).toBeHidden();
    await expect(page.getByTestId('director-panel')).toHaveCount(0);
  });
});
