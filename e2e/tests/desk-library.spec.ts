import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Frame, type Page } from '@playwright/test';
import { DESK_MESSAGE_SCHEMAS } from '../../apps/web/src/embed/protocol';
import { readPng } from '../../apps/web/test/export-files';
import { makeLibrary, openEntry, withPins, type Library } from '../fixtures/desk-host/units';
import { PLAIN } from './helpers';

/*
 * Library units in the embeddable desk (docs/embedding.md "Library units", docs/director-desk.md
 * "The Library tab"), end to end: the production build framed by the fake host on another site
 * (e2e/fixtures/desk-host), the units real unit files made by core in Node (fixtures/desk-host/
 * units.ts: the contract's example brief staged, its set, its kite and Mira's figure extracted).
 * Every message the desk sends is checked against the protocol's schemas.
 *
 * - a brief with set, figure and prop pins and their files: staged as units (state.units, the
 *   state's container version 2), the Library tab's rows, Make local (the slot stays local) and
 *   its undo
 * - a pin whose file was not sent: staged from the words (the notice, a pending row); the next open
 *   with the file offers Update shots, which places it
 * - Save to library: the set as a new item (unit-publish checked: its SHA-256, a square RGBA PNG
 *   thumbnail, from the set), linked (the scene adopts it: the tab shows it up to date, the state
 *   pins it), then a new version of it; keys typed in the dialog never reach the viewport
 * - from a read-only open: saved, never linked here
 * - the host refuses (the reason shown), or answers late (the wait shown, the dialog closed, the
 *   tab says how it ended)
 * - a host from before units (no options.units): no Library tab, no units in its states, the pins
 *   staged from the words, no unit-publish
 * - phones (390 × 844, and 360 px with the longest host name): the Library tab and the Save dialog
 *   fit, nothing scrolls sideways, Save works there
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '../..');
const FIXTURES = resolve(root, 'apps/web/test/fixtures/desk-protocol');
const HOST_PAGE = readFileSync(resolve(here, '../fixtures/desk-host/index.html'));
const DESK_URL = `${PLAIN}/desk.html`;

const fixture = (name: string) => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));
/** The contract's example brief (fixtures/open.json): Mira and Pip, the meadow and a red kite. */
const EXAMPLE = fixture('open.json').scene;
const OPTIONS = fixture('open.json').options;
const MIRA = EXAMPLE.cast.find((c: { name: string }) => c.name === 'Mira').id as string;
const KITE = EXAMPLE.elements.find((e: { name: string }) => e.name === 'Red kite').id as string;
/** options.units: library units on for the open, Save to library too. */
const UNITS = { version: 1, publish: true };
const WITH_UNITS = { ...OPTIONS, units: UNITS };
const THE_PLACE = "the scene's place";

/** The example brief, small and short (staging and states are what these tests check). */
function smallBrief(id: string) {
  const b = structuredClone(EXAMPLE);
  b.id = id;
  b.width = 320;
  b.height = 180;
  b.shots[0].durationSec = 0.5;
  b.shots[1].durationSec = 0.5;
  return b;
}

/** The host's library: version 1 of a set ("Meadow"), a prop ("Red kite") and Mira's figure ("Mira"). */
let lib: Library;

/** smallBrief(id) pinning the library's set, Mira's figure and the kite. */
const pinnedBrief = (id: string) =>
  withPins(smallBrief(id), { set: lib.set, cast: { [MIRA]: lib.figure }, elements: { [KITE]: lib.prop } });

// ---------------------------------------------------------------- the host

let hostServer: Server;
let hostBase: string;

test.beforeAll(async () => {
  lib = makeLibrary(
    EXAMPLE,
    { figure: MIRA, prop: KITE },
    { set: 'Meadow', prop: 'Red kite', figure: 'Mira' },
  );
  hostServer = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path !== '/') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    });
    res.end(HOST_PAGE);
  });
  await new Promise<void>((r) => hostServer.listen(0, '127.0.0.1', r));
  // localhost: another site than the desk's 127.0.0.1
  hostBase = `http://localhost:${(hostServer.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise((r) => hostServer.close(r));
});

interface Rec {
  at: number;
  message: any;
  bad?: boolean;
  sibling?: boolean;
  extra?: boolean;
}

const hostUrl = () => `${hostBase}/?desk=${encodeURIComponent(DESK_URL)}`;

async function openHost(page: Page): Promise<void> {
  await page.goto(hostUrl());
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
}

/** The desk's frame (once it has navigated; the newest after a remount). */
async function deskFrame(page: Page): Promise<Frame> {
  await expect
    .poll(() => page.frames().some((f) => f.url().startsWith(DESK_URL) && !f.isDetached()), {
      timeout: 30_000,
    })
    .toBe(true);
  return page.frames().find((f) => f.url().startsWith(DESK_URL) && !f.isDetached())!;
}

/** The messages of the connected port. */
const portMessages = async (page: Page): Promise<any[]> =>
  ((await page.evaluate(() => (window as any).host.messages())) as Rec[])
    .filter((r) => !r.bad && !r.sibling && !r.extra)
    .map((r) => r.message);
const ofType = async (page: Page, type: string) => (await portMessages(page)).filter((m) => m.type === type);

/** Waits until the desk has sent `count` messages of `type` (on the connected port); returns them. */
async function waitFor(page: Page, type: string, count = 1, timeout = 60_000): Promise<any[]> {
  await page.waitForFunction(
    ([t, n]) =>
      (window as any).host
        .messages()
        .filter((r: Rec) => !r.bad && !r.sibling && !r.extra && r.message?.type === t).length >=
      (n as number),
    [type, count] as const,
    { timeout, polling: 100 },
  );
  return ofType(page, type);
}

const send = (page: Page, message: unknown) => page.evaluate((m) => (window as any).host.send(m), message);

/**
 * The host opens `scene`: `options` the open's, `units` its library units (openEntry, or
 * "ref@version" of a unit the host saved), `withState` with the last state the desk sent.
 */
const hostOpen = (
  page: Page,
  scene: unknown,
  opts: { options?: unknown; units?: unknown[]; withState?: boolean } = {},
) => page.evaluate(([s, o]) => (window as any).host.open(s, o), [scene, opts] as const);

/** A message as the desk sent it: {"$bytes"} as ArrayBuffers. */
function revive(m: any): any {
  return JSON.parse(JSON.stringify(m), (_k, v) => {
    if (v && typeof v === 'object' && typeof v.$bytes === 'string') {
      const b = Buffer.from(v.$bytes, 'base64');
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
    return v;
  });
}

/** Every message the desk sent on the port validates against the protocol's schema of its type. */
async function expectValidMessages(page: Page): Promise<void> {
  for (const m of await portMessages(page)) {
    const schema = (DESK_MESSAGE_SCHEMAS as Record<string, { safeParse(v: unknown): any }>)[m.type];
    expect(schema, `a message of type ${m.type}`).toBeTruthy();
    const r = schema.safeParse(revive(m));
    expect(r.success, `${m.type}: ${JSON.stringify(r.error?.issues?.slice(0, 3))}`).toBe(true);
  }
}

/** The host asks for the desk's state now (save `id`); the state message that answers it. */
async function stateNow(page: Page, id: string): Promise<any> {
  await send(page, { type: 'save', id });
  await expect
    .poll(async () => (await ofType(page, 'state')).some((m) => m.id === id), { timeout: 30_000 })
    .toBe(true);
  return (await ofType(page, 'state')).find((m) => m.id === id);
}

/** The desk state's container version (byte 8 of its data): 2 once the scene holds library units. */
const containerVersion = (state: any): number => Buffer.from(state.state.data.$bytes, 'base64')[8];

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A state.units row staged as a unit (`local`: made local). */
const unitRow = (slot: string, u: { ref: string; version: number; sha256: string }, local = false) => ({
  slot,
  ref: u.ref,
  version: u.version,
  sha256: u.sha256,
  staged: 'unit',
  local,
});

/**
 * The unit-publish messages the desk sent, each checked: its file is what its SHA-256 says, its
 * thumbnail a square RGBA PNG of 256, 192 or 128 px with something drawn on its clear ground.
 */
async function publishes(page: Page): Promise<any[]> {
  const out = await ofType(page, 'unit-publish');
  for (const m of out) {
    expect(m.unit).toMatchObject({ format: '3d-editor.desk-unit', version: 1 });
    expect(sha256(Buffer.from(m.unit.data.$bytes, 'base64')), `${m.id}: its file's SHA-256`).toBe(m.sha256);
    expect(m.thumbnail?.mime, `${m.id}: a thumbnail`).toBe('image/png');
    const png = readPng(new Uint8Array(Buffer.from(m.thumbnail.data.$bytes, 'base64')));
    expect([256, 192, 128]).toContain(png.width);
    expect(png.height).toBe(png.width);
    expect(png.colorType).toBe(6);
    let drawn = 0;
    for (let i = 3; i < png.pixels.length; i += 4) if (png.pixels[i] > 0) drawn++;
    expect(drawn, `${m.id}: its thumbnail shows the unit`).toBeGreaterThan(png.width * png.height * 0.01);
  }
  return out;
}

const hostLibrary = (page: Page): Promise<{ key: string; sha256: string }[]> =>
  page.evaluate(() => (window as any).host.library());

interface RowSeen {
  key: string;
  status: string;
  kind: string;
  version: number;
  name: string;
  text: string;
  makeLocal: boolean;
}

/** The Library tab's rows as shown. */
const rowsOf = (frame: Frame): Promise<RowSeen[]> =>
  frame.getByTestId('desk-library-row').evaluateAll((els) =>
    els.map((e) => ({
      key: e.getAttribute('data-key') ?? '',
      status: e.getAttribute('data-status') ?? '',
      kind: e.getAttribute('data-kind') ?? '',
      version: Number(e.getAttribute('data-version')),
      name: e.querySelector('[data-testid="desk-library-name"]')?.textContent ?? '',
      text: e.querySelector('[data-testid="desk-library-status"]')?.textContent ?? '',
      makeLocal: !!e.querySelector('[data-testid="desk-library-make-local"]'),
    })),
  );

const rowOf = (frame: Frame, key: string) =>
  frame.locator(`[data-testid="desk-library-row"][data-key="${key}"]`);

/** Opens Save to library from the Library tab with `what` chosen; waits for the unit's preview. */
async function openSave(frame: Frame, what: string): Promise<void> {
  await frame.getByTestId('bottom-tab-library').click();
  await frame.getByTestId('desk-library-save').click();
  await expect(frame.getByTestId('desk-save')).toBeVisible();
  await frame.getByTestId('desk-save-what').selectOption(what);
  await expect(frame.getByTestId('desk-save-preview')).toHaveAttribute('data-status', 'ok', {
    timeout: 90_000,
  });
}

/** In the desk's page: the boxes of `ids`, whether each is the element at its centre, the page's widths. */
async function layoutOf(frame: Frame, ids: string[]) {
  return frame.evaluate((list) => {
    const out: Record<string, { left: number; right: number; top: boolean }> = {};
    for (const id of list) {
      const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (!el) throw new Error(`no ${id}`);
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      out[id] = { left: r.left, right: r.right, top: !!hit && (el === hit || el.contains(hit)) };
    }
    return { out, width: innerWidth, scroll: document.documentElement.scrollWidth };
  }, ids);
}

// ---------------------------------------------------------------- the tests

test.describe('library units in the embedded desk', () => {
  test('pins with their files: set, figure and prop staged as units; the Library tab; Make local and its undo', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openHost(page);
    const [ready] = await waitFor(page, 'ready', 1, 30_000);
    expect(ready.capabilities.units).toEqual({
      versions: [1],
      kinds: ['set', 'prop', 'figure'],
      maxBytes: 32 * 1024 * 1024,
      publish: true,
    });
    const scene = pinnedBrief('clp_libpins00000001');
    await hostOpen(page, scene, {
      options: WITH_UNITS,
      units: [openEntry(lib.set), openEntry(lib.figure), openEntry(lib.prop)],
    });
    const [opened] = await waitFor(page, 'opened', 1, 180_000);
    expect(opened).toEqual({ type: 'opened', sceneId: scene.id, source: 'brief', changes: null });
    const [state] = await waitFor(page, 'state');
    // one row per pinned slot, sorted by slot, each staged as its unit
    expect(state.units).toEqual([
      unitRow(`cast:${MIRA}`, lib.figure),
      unitRow(`el:${KITE}`, lib.prop),
      unitRow('set', lib.set),
    ]);
    expect(containerVersion(state)).toBe(2);
    const frame = await deskFrame(page);
    await expect(frame.getByTestId('desk-notice')).toHaveCount(0);
    await frame.getByTestId('bottom-tab-library').click();
    await expect(frame.getByTestId('desk-library')).toBeVisible();
    await expect(frame.getByTestId('desk-library-count')).toHaveText('3');
    // the set, the cast, the elements: each the library's version 1, up to date
    expect(await rowsOf(frame)).toEqual([
      {
        key: 'set',
        status: 'current',
        kind: 'set',
        version: 1,
        name: 'Meadow',
        text: 'up to date',
        makeLocal: true,
      },
      {
        key: `cast:${MIRA}`,
        status: 'current',
        kind: 'figure',
        version: 1,
        name: 'Mira',
        text: 'up to date',
        makeLocal: true,
      },
      {
        key: `el:${KITE}`,
        status: 'current',
        kind: 'prop',
        version: 1,
        name: 'Red kite',
        text: 'up to date',
        makeLocal: true,
      },
    ]);
    await expect(frame.getByTestId('desk-library-save')).toBeEnabled();

    // Make local: the kite's objects stay as plain ones of the scene, its slot stays local
    const objects = await frame.evaluate(() => (window as any).__desk.objects());
    const kite = rowOf(frame, `el:${KITE}`);
    await kite.getByTestId('desk-library-make-local').click();
    await expect(frame.getByTestId('desk-library-note')).toHaveText(
      'Red kite is local now: it stays as it is (Ctrl+Z undoes it).',
    );
    await expect(kite).toHaveAttribute('data-status', 'local');
    await expect(kite.getByTestId('desk-library-status')).toHaveText('made local: it stays as it is');
    await expect(kite.getByTestId('desk-library-make-local')).toHaveCount(0);
    expect(await frame.evaluate(() => (window as any).__desk.objects())).toBe(objects);
    const local = await stateNow(page, 'save-local');
    expect(local.units).toEqual([
      unitRow(`cast:${MIRA}`, lib.figure),
      unitRow(`el:${KITE}`, lib.prop, true),
      unitRow('set', lib.set),
    ]);
    // one undo step: the kite is the library's again
    const undo = await frame.evaluate(() => (window as any).__desk.run('ed.undo'));
    expect(undo.ok, undo.error).toBe(true);
    await expect(kite).toHaveAttribute('data-status', 'current');
    await expect(kite.getByTestId('desk-library-make-local')).toBeVisible();
    const undone = await stateNow(page, 'save-undone');
    expect(undone.units).toEqual(state.units);
    expect(await ofType(page, 'unit-publish')).toEqual([]);
    await expectValidMessages(page);
  });

  test('a pin whose file was not sent stages from the words; the next open with the file offers Update shots, which places it', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await openHost(page);
    await waitFor(page, 'ready', 1, 30_000);
    const scene = pinnedBrief('clp_libmissing00001');
    // the host sends the set's and the figure's files, not the kite's
    await hostOpen(page, scene, { options: WITH_UNITS, units: [openEntry(lib.set), openEntry(lib.figure)] });
    await waitFor(page, 'opened', 1, 180_000);
    const [state] = await waitFor(page, 'state');
    expect(state.units).toEqual([
      unitRow(`cast:${MIRA}`, lib.figure),
      {
        slot: `el:${KITE}`,
        ref: lib.prop.ref,
        version: 1,
        sha256: lib.prop.sha256,
        staged: 'pending',
        local: false,
        why: 'missing',
      },
      unitRow('set', lib.set),
    ]);
    let frame = await deskFrame(page);
    await expect(frame.getByTestId('desk-notice')).toContainText(
      `1 library unit was not used, so its slot is staged from the brief's words. Red kite (${lib.prop.ref} v1): its file was not sent.`,
    );
    await frame.getByTestId('bottom-tab-library').click();
    const kite = (f: Frame) => rowOf(f, `el:${KITE}`);
    await expect(kite(frame)).toHaveAttribute('data-status', 'pending');
    await expect(kite(frame).getByTestId('desk-library-status')).toHaveText(
      'waiting: its file was not sent; staged from the words',
    );
    await expect(kite(frame).getByTestId('desk-library-make-local')).toHaveCount(0);
    await expectValidMessages(page);

    // the next open (a new page, the host's state) brings the kite's file
    await page.evaluate(() => (window as any).host.mount());
    await waitFor(page, 'ready', 2, 30_000);
    await hostOpen(page, scene, { withState: true, options: WITH_UNITS, units: [openEntry(lib.prop)] });
    await waitFor(page, 'opened', 2, 180_000);
    frame = await deskFrame(page);
    await expect(frame.getByTestId('desk-changes-text')).toContainText('1 prop from the library');
    await frame.getByTestId('bottom-tab-library').click();
    await expect(kite(frame)).toHaveAttribute('data-status', 'update');
    await expect(kite(frame).getByTestId('desk-library-status')).toHaveText(
      'v1 is here: Update shots places it',
    );
    // the set and the figure stay the scene's instances (their files are not sent again)
    await expect(rowOf(frame, 'set')).toHaveAttribute('data-status', 'current');
    await expect(rowOf(frame, `cast:${MIRA}`)).toHaveAttribute('data-status', 'current');
    await frame.getByTestId('desk-update-shots').click();
    await expect(frame.getByTestId('desk-changes')).toHaveCount(0, { timeout: 60_000 });
    await expect(kite(frame)).toHaveAttribute('data-status', 'current');
    await expect(kite(frame).getByTestId('desk-library-status')).toHaveText('up to date');
    const placed = await stateNow(page, 'save-placed');
    expect(placed.units).toEqual([
      unitRow(`cast:${MIRA}`, lib.figure),
      unitRow(`el:${KITE}`, lib.prop),
      unitRow('set', lib.set),
    ]);
    await expectValidMessages(page);
  });

  test('Save to library: the set as a new item, linked (the scene adopts it), then a new version of it', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await openHost(page);
    await waitFor(page, 'ready', 1, 30_000);
    const scene = smallBrief('clp_libsave00000001');
    await hostOpen(page, scene, { options: WITH_UNITS });
    await waitFor(page, 'opened', 1, 180_000);
    const [first] = await waitFor(page, 'state');
    // units on, nothing pinned: no rows, a state with none, a container of version 1
    expect(first.units).toEqual([]);
    expect(containerVersion(first)).toBe(1);
    const frame = await deskFrame(page);
    await frame.getByTestId('bottom-tab-library').click();
    await expect(frame.getByTestId('desk-library-empty')).toBeVisible();
    await expect(frame.getByTestId('desk-library-count')).toHaveText('0');
    await expect(frame.getByTestId('desk-library-save')).toHaveAttribute(
      'title',
      "Save the set, an actor or a prop of this scene to rideo's library",
    );

    // What: the set first, then each actor by its cast member's name and each prop
    await openSave(frame, 'set');
    const labels = await frame.getByTestId('desk-save-what').locator('option').allTextContents();
    expect(labels[0]).toBe('The set');
    expect(labels).toEqual(expect.arrayContaining(['Mira (actor)', 'Pip (actor)', 'Red kite (prop)']));
    await expect(frame.getByTestId('desk-save-name')).toHaveValue('The meadow');
    await expect(frame.getByTestId('desk-save-new-item')).toHaveText('A new item in rideo’s library (set).');
    await expect(frame.getByTestId('desk-save-new-version')).toHaveCount(0);
    await expect(frame.getByTestId('desk-save-thumbnail')).toBeVisible();
    await expect(frame.getByTestId('desk-save-counts')).toHaveText(
      /^[\d,]+ objects? · [\d,]+ triangles? · [\d.]+ (B|KiB|MiB) · [\d.]+ × [\d.]+ × [\d.]+ m$/,
    );
    const dialog = (await frame.locator('.desk-modal.desk-save').boundingBox())!;
    expect(dialog.width).toBeLessThanOrEqual(440);
    // keys typed in the dialog are the field's: none reaches the viewport (a, r, b: viewport keys)
    const objects = await frame.evaluate(() => (window as any).__desk.objects());
    const name = frame.getByTestId('desk-save-name');
    await name.fill('');
    await name.pressSequentially('Harbor');
    await expect(name).toHaveValue('Harbor');
    await frame.getByTestId('desk-save-description').fill('The meadow as a harbour, for the sea scenes.');
    expect(await frame.evaluate(() => (window as any).__desk.objects())).toBe(objects);

    await frame.getByTestId('desk-save-submit').click();
    const result = frame.getByTestId('desk-save-result');
    await expect(result).toHaveText(`Saved 'Harbor' v1 to rideo; linked to ${THE_PLACE}`, {
      timeout: 90_000,
    });
    await expect(result).toHaveAttribute('data-outcome', 'linked');
    await expect(frame.getByTestId('desk-save-submit')).toHaveCount(0);
    const [pub] = await publishes(page);
    expect(pub).toMatchObject({
      kind: 'set',
      name: 'Harbor',
      description: 'The meadow as a harbour, for the sea scenes.',
      from: { castId: null, elementId: null, set: true },
    });
    expect(pub.newVersionOf).toBeUndefined();
    expect(await hostLibrary(page)).toEqual([{ key: 'lib_e2e0001@1', sha256: pub.sha256 }]);
    await frame.getByTestId('desk-save-cancel').click();
    await expect(frame.getByTestId('desk-save')).toHaveCount(0);
    // the tab: the scene's set is the library's Harbor v1 now, up to date
    expect(await rowsOf(frame)).toEqual([
      {
        key: 'set',
        status: 'current',
        kind: 'set',
        version: 1,
        name: 'Harbor',
        text: 'up to date',
        makeLocal: true,
      },
    ]);
    await expect(frame.getByTestId('desk-library-last')).toHaveText(
      `Saved 'Harbor' v1 to rideo; linked to ${THE_PLACE}`,
    );
    const linked = await stateNow(page, 'save-linked');
    expect(linked.units).toEqual([unitRow('set', { ref: 'lib_e2e0001', version: 1, sha256: pub.sha256 })]);
    expect(containerVersion(linked)).toBe(2);
    expect(await frame.evaluate(() => (window as any).__desk.controller.brief.value.set.unit)).toEqual({
      ref: 'lib_e2e0001',
      version: 1,
      sha256: pub.sha256,
    });

    // a new version of it: the dialog offers it, ticked
    await openSave(frame, 'set');
    await expect(frame.getByTestId('desk-save-name')).toHaveValue('Harbor');
    await expect(frame.getByTestId('desk-save-new-version')).toBeChecked();
    await expect(frame.locator('.desk-save-check')).toHaveText('Save as a new version of Harbor v1');
    await frame.getByTestId('desk-save-submit').click();
    await expect(result).toHaveText(`Saved 'Harbor' v2 to rideo; linked to ${THE_PLACE}`, {
      timeout: 90_000,
    });
    const pubs = await publishes(page);
    expect(pubs).toHaveLength(2);
    expect(pubs[1]).toMatchObject({
      kind: 'set',
      name: 'Harbor',
      newVersionOf: { ref: 'lib_e2e0001', version: 1 },
      from: { castId: null, elementId: null, set: true },
    });
    expect(await hostLibrary(page)).toEqual([
      { key: 'lib_e2e0001@1', sha256: pub.sha256 },
      { key: 'lib_e2e0001@2', sha256: pubs[1].sha256 },
    ]);
    await frame.getByTestId('desk-save-cancel').click();
    expect(await rowsOf(frame)).toEqual([
      {
        key: 'set',
        status: 'current',
        kind: 'set',
        version: 2,
        name: 'Harbor',
        text: 'up to date',
        makeLocal: true,
      },
    ]);
    const second = await stateNow(page, 'save-v2');
    expect(second.units).toEqual([
      unitRow('set', { ref: 'lib_e2e0001', version: 2, sha256: pubs[1].sha256 }),
    ]);
    await expectValidMessages(page);
  });

  test('Save to library from a read-only open: saved, never linked here', async ({ page }) => {
    test.setTimeout(240_000);
    await openHost(page);
    await waitFor(page, 'ready', 1, 30_000);
    const scene = smallBrief('clp_libreadonly0001');
    await hostOpen(page, scene, { options: { hostName: 'rideo', readOnly: true, units: UNITS } });
    await waitFor(page, 'opened', 1, 180_000);
    const frame = await deskFrame(page);
    await expect(frame.getByTestId('desk-read-only')).toBeVisible();
    await openSave(frame, 'set');
    await expect(frame.getByTestId('desk-save-read-only')).toHaveText(
      'The scene is read-only here: rideo may save the unit, and the scene stays as it is.',
    );
    await frame.getByTestId('desk-save-name').fill('Dock');
    await frame.getByTestId('desk-save-submit').click();
    const result = frame.getByTestId('desk-save-result');
    await expect(result).toHaveText(
      "Saved 'Dock' v1 to rideo; not linked here: The scene is read-only here: it stays as it is.",
      { timeout: 90_000 },
    );
    await expect(result).toHaveAttribute('data-outcome', 'unlinked');
    const [pub] = await publishes(page);
    expect(pub).toMatchObject({ kind: 'set', name: 'Dock', from: { set: true } });
    expect(await hostLibrary(page)).toEqual([{ key: 'lib_e2e0001@1', sha256: pub.sha256 }]);
    await frame.getByTestId('desk-save-cancel').click();
    // nothing adopted: no rows, no pin, no units in the state
    await expect(frame.getByTestId('desk-library-empty')).toBeVisible();
    await expect(frame.getByTestId('desk-library-last')).toHaveAttribute('data-outcome', 'unlinked');
    expect(
      await frame.evaluate(() => (window as any).__desk.controller.brief.value.set.unit ?? null),
    ).toBeNull();
    expect(await frame.evaluate(() => (window as any).__desk.workspace.libraryRows())).toEqual([]);
    const after = await stateNow(page, 'save-ro');
    expect(after.units).toEqual([]);
    await expectValidMessages(page);
  });

  test('the host refuses (its reason shown) or answers late (the wait shown, the tab says how it ended)', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openHost(page);
    await waitFor(page, 'ready', 1, 30_000);
    await hostOpen(page, smallBrief('clp_librefused00001'), { options: WITH_UNITS });
    await waitFor(page, 'opened', 1, 180_000);
    const frame = await deskFrame(page);

    // refused
    await page.evaluate(() =>
      (window as any).host.publishMode('refused:refused', 'Only producers add to the studio library.'),
    );
    await openSave(frame, 'set');
    await frame.getByTestId('desk-save-name').fill('Harbor');
    await frame.getByTestId('desk-save-submit').click();
    const result = frame.getByTestId('desk-save-result');
    await expect(result).toHaveText('Not saved: Only producers add to the studio library.', {
      timeout: 90_000,
    });
    await expect(result).toHaveAttribute('data-outcome', 'failed');
    await expect(result).toHaveAttribute('data-code', 'refused');
    expect(await hostLibrary(page)).toEqual([]);
    await frame.getByTestId('desk-save-cancel').click();
    await expect(frame.getByTestId('desk-library-last')).toHaveText(
      'Not saved: Only producers add to the studio library.',
    );
    await expect(frame.getByTestId('desk-library-last')).toHaveAttribute('data-outcome', 'failed');
    await expect(frame.getByTestId('desk-library-empty')).toBeVisible();

    // an answer that takes its time: the wait shows; closed, the save goes on and the tab tells the end
    await page.evaluate(() => (window as any).host.publishMode('never'));
    await openSave(frame, 'set');
    await frame.getByTestId('desk-save-submit').click();
    const progress = frame.getByTestId('desk-save-progress');
    await expect(progress).toHaveAttribute('data-phase', 'waiting', { timeout: 90_000 });
    await expect(progress).toHaveText(/^Waiting for rideo to save 'The meadow'… \d+ s$/);
    await expect(frame.getByTestId('desk-save-submit')).toHaveText('Saving…');
    await expect(frame.getByTestId('desk-save-cancel')).toHaveText('Close');
    await frame.getByTestId('desk-save-cancel').click();
    await expect(frame.getByTestId('desk-save')).toHaveCount(0);
    await expect(frame.getByTestId('desk-library-publishing')).toHaveAttribute('data-phase', 'waiting');
    await expect(frame.getByTestId('desk-library-save')).toBeDisabled();
    await expect(frame.getByTestId('desk-library-save')).toHaveAttribute(
      'title',
      'A unit is being saved to the library.',
    );
    const pubs = await publishes(page);
    expect(pubs).toHaveLength(2);
    await page.evaluate((id) => (window as any).host.ackPublish(id, { ok: true, linked: false }), pubs[1].id);
    const last = frame.getByTestId('desk-library-last');
    await expect(last).toHaveText(
      "Saved 'The meadow' v1 to rideo; not linked: rideo keeps the scene's pin as it was",
    );
    await expect(last).toHaveAttribute('data-outcome', 'unlinked');
    await expect(frame.getByTestId('desk-library-publishing')).toHaveCount(0);
    await expect(frame.getByTestId('desk-library-save')).toBeEnabled();
    await expect(frame.getByTestId('desk-library-empty')).toBeVisible();
    expect(await hostLibrary(page)).toEqual([{ key: 'lib_e2e0001@1', sha256: pubs[1].sha256 }]);
    await expectValidMessages(page);
  });

  test('a host from before units (no options.units): no Library tab, no units in its states, pins staged from the words', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openHost(page);
    const [ready] = await waitFor(page, 'ready', 1, 30_000);
    // the desk says what it can; this host does not read it
    expect(ready.capabilities.units.publish).toBe(true);
    const scene = pinnedBrief('clp_liboldhost00001');
    // pins and files, but no options.units: the desk reads neither
    await hostOpen(page, scene, {
      options: OPTIONS,
      units: [openEntry(lib.set), openEntry(lib.figure), openEntry(lib.prop)],
    });
    const [opened] = await waitFor(page, 'opened', 1, 180_000);
    expect(opened).toEqual({ type: 'opened', sceneId: scene.id, source: 'brief', changes: null });
    const [state] = await waitFor(page, 'state');
    expect('units' in state).toBe(false);
    expect(containerVersion(state)).toBe(1);
    const frame = await deskFrame(page);
    await expect(frame.getByTestId('bottom-tab-sequence')).toBeVisible();
    await expect(frame.getByTestId('bottom-tab-library')).toHaveCount(0);
    await expect(frame.getByTestId('desk-library')).toHaveCount(0);
    await expect(frame.getByTestId('desk-notice')).toHaveCount(0);
    // the brief the desk follows has no pins; the scene holds no library unit
    const pins = await frame.evaluate(() => {
      const b = (window as any).__desk.controller.brief.value;
      return [b.set.unit, ...b.cast.map((c: any) => c.unit), ...b.elements.map((e: any) => e.unit)].filter(
        Boolean,
      );
    });
    expect(pins).toEqual([]);
    expect(await frame.evaluate(() => (window as any).__desk.workspace.libraryRows())).toEqual([]);
    const saved = await stateNow(page, 'save-old');
    expect('units' in saved).toBe(false);
    expect(containerVersion(saved)).toBe(1);
    expect(await ofType(page, 'unit-publish')).toEqual([]);
    await expectValidMessages(page);
  });

  test('on a phone of 390 × 844: the Library tab and the Save dialog fit, and Save works there', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await openHost(page);
    await waitFor(page, 'ready', 1, 30_000);
    const scene = pinnedBrief('clp_libphone0000001');
    await hostOpen(page, scene, {
      options: WITH_UNITS,
      units: [openEntry(lib.set), openEntry(lib.figure), openEntry(lib.prop)],
    });
    await waitFor(page, 'opened', 1, 180_000);
    await waitFor(page, 'state');
    const frame = await deskFrame(page);
    await frame.getByTestId('bottom-tab-library').click();
    await expect(frame.getByTestId('desk-library-row')).toHaveCount(3);
    // the panel: Save and each row's Make local inside the frame, each the element at its centre
    const tab = await frame.evaluate(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="desk-library-make-local"]')];
      return rows.map((b) => {
        b.scrollIntoView({ block: 'nearest' });
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { right: r.right, left: r.left, top: !!hit && (b === hit || b.contains(hit)) };
      });
    });
    expect(tab).toHaveLength(3);
    for (const b of tab) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(390);
      expect(b.top, 'Make local is the element at its centre').toBe(true);
    }
    const save = await layoutOf(frame, ['desk-library-save']);
    expect(save.width).toBe(390);
    expect(save.scroll).toBeLessThanOrEqual(390);
    expect(save.out['desk-library-save'].right).toBeLessThanOrEqual(390);
    expect(save.out['desk-library-save'].top).toBe(true);

    // the dialog: min(440 px, the frame less 32 px) wide, its controls in the frame
    await openSave(frame, 'set');
    await expect(frame.getByTestId('desk-save-new-version')).toBeChecked();
    const box = (await frame.locator('.desk-modal.desk-save').boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(390 - 32 + 0.5);
    expect(box.x).toBeGreaterThanOrEqual(16 - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(390 - 16 + 0.5);
    const inDialog = await layoutOf(frame, [
      'desk-save-what',
      'desk-save-name',
      'desk-save-description',
      'desk-save-new-version',
      'desk-save-cancel',
      'desk-save-submit',
    ]);
    expect(inDialog.scroll).toBeLessThanOrEqual(390);
    for (const [id, b] of Object.entries(inDialog.out)) {
      expect(b.left, id).toBeGreaterThanOrEqual(box.x - 0.5);
      expect(b.right, id).toBeLessThanOrEqual(box.x + box.width + 0.5);
      expect(b.top, `${id} is the element at its centre`).toBe(true);
    }
    expect(await frame.locator('.desk-modal.desk-save').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
      true,
    );
    await frame.getByTestId('desk-save-submit').click();
    const result = frame.getByTestId('desk-save-result');
    await expect(result).toHaveText(`Saved 'Meadow' v2 to rideo; linked to ${THE_PLACE}`, {
      timeout: 90_000,
    });
    const [pub] = await publishes(page);
    expect(pub.newVersionOf).toEqual({ ref: lib.set.ref, version: 1 });
    const done = await layoutOf(frame, ['desk-save-result', 'desk-save-cancel']);
    expect(done.out['desk-save-result'].right).toBeLessThanOrEqual(box.x + box.width + 0.5);
    expect(done.scroll).toBeLessThanOrEqual(390);
    await frame.getByTestId('desk-save-cancel').click();
    await expect(rowOf(frame, 'set')).toHaveAttribute('data-version', '2');
    await expect(rowOf(frame, 'set')).toHaveAttribute('data-status', 'current');
    expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // the phone turned sideways: the dialog keeps within the frame's height, scrolling inside it
    await page.setViewportSize({ width: 844, height: 390 });
    await openSave(frame, 'set');
    const turned = (await frame.locator('.desk-modal.desk-save').boundingBox())!;
    expect(turned.y).toBeGreaterThanOrEqual(0);
    expect(turned.y + turned.height).toBeLessThanOrEqual(390 + 0.5);
    const reach = await layoutOf(frame, ['desk-save-what', 'desk-save-name', 'desk-save-submit']);
    for (const [id, b] of Object.entries(reach.out)) expect(b.top, `${id} can be reached`).toBe(true);
    expect(reach.scroll).toBeLessThanOrEqual(844);
    await frame.getByTestId('desk-save-cancel').click();
    await expect(frame.getByTestId('desk-save')).toHaveCount(0);
    await expectValidMessages(page);
  });

  test('on a phone of 360 px with the longest host name: the tab, the dialog and its notices fit', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 360, height: 740 });
    await openHost(page);
    await waitFor(page, 'ready', 1, 30_000);
    const hostName = 'Storyboard Studio Online for Film Crews!';
    expect(hostName).toHaveLength(40);
    await hostOpen(page, smallBrief('clp_libphone0000002'), { options: { ...WITH_UNITS, hostName } });
    await waitFor(page, 'opened', 1, 180_000);
    await waitFor(page, 'state');
    const frame = await deskFrame(page);
    await frame.getByTestId('bottom-tab-library').click();
    await expect(frame.getByTestId('desk-library-empty')).toBeVisible();
    const tab = await layoutOf(frame, ['desk-library-save', 'desk-library-empty']);
    expect(tab.width).toBe(360);
    expect(tab.scroll).toBeLessThanOrEqual(360);
    for (const [id, b] of Object.entries(tab.out)) expect(b.right, id).toBeLessThanOrEqual(360);
    expect(tab.out['desk-library-save'].top).toBe(true);

    // the longest name a unit takes, and the host's: nothing scrolls sideways
    await openSave(frame, 'set');
    const longName = 'The long harbour walk at dawn, nets and gulls, '.repeat(3).slice(0, 119) + '!';
    expect(longName).toHaveLength(120);
    await frame.getByTestId('desk-save-name').fill(longName);
    await page.evaluate(() => (window as any).host.publishMode('unlinked'));
    await frame.getByTestId('desk-save-submit').click();
    const result = frame.getByTestId('desk-save-result');
    await expect(result).toHaveText(
      `Saved '${longName}' v1 to ${hostName}; not linked: ${hostName} keeps the scene's pin as it was`,
      { timeout: 90_000 },
    );
    const box = (await frame.locator('.desk-modal.desk-save').boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(360 - 32 + 0.5);
    const done = await layoutOf(frame, ['desk-save-result', 'desk-save-cancel', 'desk-save-name']);
    expect(done.scroll).toBeLessThanOrEqual(360);
    for (const [id, b] of Object.entries(done.out)) {
      expect(b.right, id).toBeLessThanOrEqual(box.x + box.width + 0.5);
      expect(b.top, `${id} is the element at its centre`).toBe(true);
    }
    expect(await frame.locator('.desk-modal.desk-save').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
      true,
    );
    await frame.getByTestId('desk-save-cancel').click();
    const last = await layoutOf(frame, ['desk-library-last']);
    expect(last.out['desk-library-last'].right).toBeLessThanOrEqual(360);
    expect(last.scroll).toBeLessThanOrEqual(360);
    await expectValidMessages(page);
  });
});
