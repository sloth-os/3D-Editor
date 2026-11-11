import { test, expect } from '@playwright/test';
import {
  PLAIN,
  callJson,
  changedFraction,
  mcpConnect,
  menuPath,
  newProject,
  setNumberField,
  statNumber,
  viewportCentre,
  viewportPictures,
} from './helpers';

test.describe('curves and text', () => {
  test('a Bezier curve gets a surface from the bevel depth in the Object Data tab', async ({ page }) => {
    // an empty scene: no default cube around the curve, which is added at the origin
    const id = await newProject(page, PLAIN, { empty: true });
    await menuPath(page, ['Add', 'Curve', 'Bezier']);
    await expect(page.getByTestId('outliner-BezierCurve')).toHaveClass(/active/);
    // a plain wire curve has no surface: nothing to count yet
    await expect(page.getByTestId('viewport-stats')).toContainText('Objects 1/1');
    expect(await statNumber(page, 'stats-triangles')).toBe(0);
    const wire = await viewportCentre(page);

    await page.getByTestId('prop-tab-data').click();
    await expect(page.getByTestId('curve-bevel-mode-ROUND')).toHaveAttribute('aria-pressed', 'true');
    await setNumberField(page, 'curve-bevel-depth', 0.1);
    await expect(page.getByTestId('curve-bevel-depth')).toContainText('0.1 m');
    // the round bevel sweeps a tube along the curve
    await expect.poll(() => statNumber(page, 'stats-triangles')).toBeGreaterThan(100);
    const tube = await statNumber(page, 'stats-triangles');
    const tubeVertices = await statNumber(page, 'stats-vertices');
    // which the viewport draws: a solid tube across the middle of the view instead of a thin line
    await expect.poll(async () => changedFraction(wire, await viewportCentre(page))).toBeGreaterThan(0.03);

    // the server's evaluation of the synced document gives the editor's counts
    const client = await mcpConnect(PLAIN);
    await expect
      .poll(async () => (await callJson(client, 'get_object', { project: id, object: 'BezierCurve' })).data)
      .toMatchObject({
        kind: 'curve',
        bevel_depth: 0.1,
        evaluated: { triangles: tube, vertices: tubeVertices },
      });

    // a finer bevel profile gives more geometry
    await setNumberField(page, 'curve-bevel-resolution', 8);
    await expect.poll(() => statNumber(page, 'stats-triangles')).toBeGreaterThan(tube);
    // and depth 0 is a wire again, in the viewport too: pictures of depths 0, 0.1 and 0 drawn with
    // the same multisampling (a busy machine can turn it off between pictures, and edges then differ)
    const depth = async (d: number) => {
      await setNumberField(page, 'curve-bevel-depth', d);
      if (d) await expect.poll(() => statNumber(page, 'stats-triangles')).toBeGreaterThan(tube);
      else await expect.poll(() => statNumber(page, 'stats-triangles')).toBe(0);
    };
    const [flat, swept, flatAgain] = await viewportPictures(
      page,
      [() => depth(0), () => depth(0.1), () => depth(0)],
      viewportCentre,
    );
    expect(changedFraction(flat, swept)).toBeGreaterThan(0.03);
    expect(changedFraction(flat, flatAgain)).toBeLessThan(0.01);
    // as before the bevel
    if (wire.samples === flat.samples) expect(changedFraction(wire, flat)).toBeLessThan(0.01);
    await client.close();
  });

  test('a text object: add it, edit its body, convert it to a mesh', async ({ page }) => {
    const id = await newProject(page);
    const triangles = await statNumber(page, 'stats-triangles');
    await menuPath(page, ['Add', 'Text']);
    await expect(page.getByTestId('outliner-Text')).toHaveClass(/active/);
    await expect.poll(() => statNumber(page, 'stats-triangles')).toBeGreaterThan(triangles);
    const word = (await statNumber(page, 'stats-triangles')) - triangles;

    await page.getByTestId('prop-tab-data').click();
    const body = page.getByTestId('font-body');
    await expect(body).toHaveValue('Text');
    await body.fill('Hello\nWorld');
    await body.press('Control+Enter');
    await expect(page.getByTestId('prop-content-data')).toContainText('2 lines · 10 characters');
    // ten glyphs instead of four
    await expect.poll(() => statNumber(page, 'stats-triangles')).toBeGreaterThan(triangles + 2 * word);
    const text = (await statNumber(page, 'stats-triangles')) - triangles;

    const client = await mcpConnect(PLAIN);
    await expect
      .poll(async () => (await callJson(client, 'get_object', { project: id, object: 'Text' })).data)
      .toMatchObject({ kind: 'text', body: 'Hello\nWorld', evaluated: { triangles: text } });

    // Object > Convert > Mesh: the same surface as an editable mesh (text objects already have a
    // Modifiers tab, as in Blender; the text body field goes away with the conversion)
    await expect(page.getByTestId('prop-tab-modifiers')).toBeVisible();
    await menuPath(page, ['Object', 'Convert', 'Mesh']);
    await expect(page.getByTestId('prop-tab-modifiers')).toBeVisible();
    await expect(page.getByTestId('font-body')).toHaveCount(0);
    await expect(page.getByTestId('outliner-Text')).toHaveClass(/active/);
    expect(await statNumber(page, 'stats-triangles')).toBe(triangles + text);
    await expect
      .poll(async () => {
        const o = await callJson(client, 'get_object', { project: id, object: 'Text' });
        return { type: o.type, kind: o.data.kind, triangles: o.data.triangles };
      })
      .toEqual({ type: 'MESH', kind: 'mesh', triangles: text });
    // it is a real mesh now: Edit Mode works on it
    await page.getByTestId('viewport').hover();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('mode-select')).toHaveValue('EDIT');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('mode-select')).toHaveValue('OBJECT');
    await client.close();
  });
});
