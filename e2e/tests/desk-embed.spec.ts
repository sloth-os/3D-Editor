import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type BrowserContext, type Frame, type Page, type Request } from '@playwright/test';
import { DESK_MESSAGE_SCHEMAS } from '../../apps/web/src/embed/protocol';
import { avcSps, mp4Info, readPng } from '../../apps/web/test/export-files';
import { PLAIN } from './helpers';

/*
 * The embeddable director's desk (docs/embedding.md) end to end: the production build of the
 * editor server serving desk.html, framed by a fake host on another site (localhost against the
 * desk's 127.0.0.1) that is cross-origin isolated (COOP same-origin, COEP require-corp), so the
 * desk's COEP/CORP headers are what lets it load. The host (e2e/fixtures/desk-host) speaks the host
 * side of the protocol; every message the desk sends is checked against the protocol's schemas.
 *
 * - handshake, ready (export available), open the contract's example brief (staged from the brief),
 *   state, export camera + pose with stills (progress, result: two shots of 72 and 60 frames, MP4s
 *   with the index first, one avc1 track, BT.709 limited range in the colr box and the stream,
 *   exactly the shot's frames, a key frame first; RGB PNG stills), result-ack shown, save, Done;
 *   and nothing goes to the network once the desk has loaded
 * - reopening: with the host's state in a browser that has no copy (source state), with no state
 *   (source local), with a changed brief (changes listed, Update shots, one undo step)
 * - what the desk ignores or refuses: a connect from another frame, a version it does not speak,
 *   a second connect, unknown types, bad messages, export before open, a second open
 * - Close while a long brief stages: close at once, the staging stopped (no work over the closed
 *   panel, nothing kept: the next open stages the scene again)
 * - offline: the desk loads from its service worker, stages and exports with no network at all
 * - on its own: the explanation, the editor link and the sample scene; the phone layout, also at
 *   360 px with the longest host and scene names (Done and Close in the frame, Close works); at
 *   1024 px with those names the header's notes are cut short as the scene's name is, never to
 *   less than their first word, whole in their tooltips
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '../..');
const FIXTURES = resolve(root, 'apps/web/test/fixtures/desk-protocol');
const HOST_PAGE = readFileSync(resolve(here, '../fixtures/desk-host/index.html'));
const DESK_URL = `${PLAIN}/desk.html`;

const fixture = (name: string) => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));
/** The contract's example brief (fixtures/open.json): 2 shots, 72 and 60 frames at 24 fps, 1280 × 720. */
const EXAMPLE = fixture('open.json').scene;
const OPTIONS = fixture('open.json').options;
const SHOT_A = EXAMPLE.shots[0].id as string;
const SHOT_B = EXAMPLE.shots[1].id as string;

/** The example brief, small and short (for the tests whose clips are not what they check). */
function smallBrief(id = 'clp_small0000000001') {
  const b = structuredClone(EXAMPLE);
  b.id = id;
  b.width = 320;
  b.height = 180;
  b.shots[0].durationSec = 0.5;
  b.shots[1].durationSec = 0.5;
  return b;
}

/** A brief of `n` shots (copies of the example's): it takes seconds to stage. */
function longBrief(id: string, n: number) {
  const b = smallBrief(id);
  const base = b.shots;
  b.shots = Array.from({ length: n }, (_, i) => ({
    ...structuredClone(base[i % base.length]),
    id: `sht_long${String(i).padStart(8, '0')}`,
    index: i,
    durationSec: 2,
  }));
  return b;
}

// ---------------------------------------------------------------- the host

let hostServer: Server;
let hostBase: string;

test.beforeAll(async () => {
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

/** The desk's frame (once it has navigated). */
async function deskFrame(page: Page): Promise<Frame> {
  await expect
    .poll(() => page.frames().some((f) => f.url().startsWith(DESK_URL)), { timeout: 30_000 })
    .toBe(true);
  return page.frames().find((f) => f.url().startsWith(DESK_URL))!;
}

const allMessages = (page: Page): Promise<Rec[]> => page.evaluate(() => (window as any).host.messages());
/** The messages of the connected port (not the refused connects' ports). */
const portMessages = async (page: Page) =>
  (await allMessages(page)).filter((r) => !r.bad && !r.sibling && !r.extra).map((r) => r.message);
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

/** A message as the desk sent it: {"$bytes"} (states, result files) as ArrayBuffers. */
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

/**
 * In the desk's page: the room the scene's name and the header's notes `ids` have for their text
 * (`shown`), the width of their text whole (`full`), a note's first word's width (`word`) and its
 * tooltip, and where Close ends. With `wait` it first waits for the notes (a frame at a time, 2 s
 * at most).
 */
async function notesInHeader({ ids, wait = false }: { ids: string[]; wait?: boolean }) {
  const find = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  for (const t0 = performance.now(); wait && ids.some((id) => !find(id));) {
    if (performance.now() - t0 > 2000) throw new Error(`no ${ids.join(', ')} in the header`);
    await new Promise((r) => requestAnimationFrame(r));
  }
  const textWidth = (start: Node, end?: { node: Text; offset: number }) => {
    const range = document.createRange();
    range.selectNodeContents(start);
    if (end) range.setEnd(end.node, end.offset);
    return range.getBoundingClientRect().width;
  };
  const note = (id: string) => {
    const el = find(id)!;
    const s = getComputedStyle(el);
    const first = el.firstChild as Text;
    const space = first.data.search(/\s/);
    return {
      shown: el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight),
      full: textWidth(el),
      word: textWidth(el, { node: first, offset: space < 0 ? first.data.length : space }),
      title: el.getAttribute('title'),
    };
  };
  const name = find('desk-scene-name')!;
  return {
    name: { shown: name.clientWidth, full: textWidth(name) },
    notes: Object.fromEntries(ids.map((id) => [id, note(id)])),
    closeRight: find('desk-close')!.getBoundingClientRect().right,
  };
}

const fileBytes = async (page: Page, name: string): Promise<Uint8Array> => {
  const b64 = await page.evaluate((n) => (window as any).host.file(n), name);
  expect(b64, name).toBeTruthy();
  return new Uint8Array(Buffer.from(b64 as string, 'base64'));
};

/** Waits until the desk's page is controlled by its service worker (installed on this visit). */
async function deskControlled(frame: Frame): Promise<void> {
  await frame.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 60_000 });
}

/** Records the requests of `context` that reach the network (not answered by the service worker). */
function networkLog(context: BrowserContext) {
  const seen: { url: string; fromSw: boolean | null }[] = [];
  let on = false;
  const onRequest = (r: Request) => {
    if (!on) return;
    if (/^(blob|data):/.test(r.url())) return;
    const entry = { url: r.url(), fromSw: null as boolean | null };
    seen.push(entry);
    void r
      .response()
      .then((res) => (entry.fromSw = res?.fromServiceWorker() ?? false))
      .catch(() => (entry.fromSw = false));
  };
  context.on('request', onRequest);
  return {
    start: () => (on = true),
    stop: () => {
      on = false;
      context.off('request', onRequest);
    },
    /** The requests that went to the network (settled ones only). */
    network: () => seen.filter((e) => e.fromSw === false).map((e) => e.url),
    all: () => seen,
  };
}

// ---------------------------------------------------------------- the main flow

test.describe('the embeddable desk', () => {
  test('a host on another site: handshake, open, state, export, ack, save and Done', async ({
    page,
    context,
  }) => {
    test.setTimeout(480_000);
    const net = networkLog(context);
    const t0 = Date.now();
    await openHost(page);
    const [ready] = await waitFor(page, 'ready', 1, 30_000);
    const readyMs = Date.now() - t0;
    expect(ready.protocol).toBe(1);
    expect(typeof ready.deskVersion).toBe('string');
    expect(ready.capabilities.export).toMatchObject({
      available: true,
      reason: null,
      container: 'mp4',
      videoCodec: 'avc1',
    });
    expect(ready.capabilities.offline).toBe(true);
    // the desk posted nothing on window but its hello, from its origin
    const posted = await page.evaluate(() => (window as any).host.windowMessages());
    expect(posted).toEqual([{ origin: PLAIN, data: { protocol: '3d-desk', type: 'hello', versions: [1] } }]);

    const frame = await deskFrame(page);
    await expect(frame.getByTestId('desk-app')).toHaveAttribute('data-status', 'connected');
    // its service worker installs on this first visit; from then on nothing reaches the network
    await deskControlled(frame);
    net.start();

    // open the example brief: staged from the brief, then its first state
    const tOpen = Date.now();
    await send(page, { type: 'open', scene: EXAMPLE, state: null, options: OPTIONS });
    const [opened] = await waitFor(page, 'opened', 1, 180_000);
    const openMs = Date.now() - tOpen;
    expect(opened).toEqual({ type: 'opened', sceneId: EXAMPLE.id, source: 'brief', changes: null });
    const [state] = await waitFor(page, 'state', 1);
    expect(state).toMatchObject({
      sceneId: EXAMPLE.id,
      shots: 2,
      state: { format: '3d-editor.desk-state', version: 1 },
    });
    expect(state.id).toBeUndefined();
    await expect(frame.getByTestId('desk-scene-name')).toHaveText(EXAMPLE.name);
    await expect(frame.getByTestId('desk-source')).toHaveAttribute('data-source', 'brief');
    await expect(frame.getByTestId('desk-send')).toContainText('Send to rideo');
    await expect(frame.getByTestId('desk-app')).toHaveAttribute('data-status', 'open');
    // the Director workspace, focused: viewport, shot list, sequence; none of the editor's chrome
    await expect(frame.getByTestId('viewport')).toBeVisible();
    await expect(frame.getByTestId('director-panel')).toBeVisible();
    await expect(frame.getByTestId('bottom-tab-sequence')).toBeVisible();
    await expect(frame.locator('.topbar')).toHaveCount(0);
    for (const id of [
      'menu-button-file',
      'workspace-layout',
      'presence',
      'open-projects',
      'statusbar',
      'bottom-tab-console',
      'bottom-tab-diagnostics',
      'bottom-tab-uv',
      'bottom-tab-dopesheet',
    ])
      await expect(frame.getByTestId(id)).toHaveCount(0);

    // export camera + pose with stills
    const tExport = Date.now();
    await send(page, { type: 'export', id: 'exp-1', modes: ['camera', 'pose'], still: true });
    const [result] = await waitFor(page, 'result', 1, 420_000);
    const exportMs = Date.now() - tExport;
    expect(await ofType(page, 'error')).toEqual([]);
    const progress = (await ofType(page, 'progress')).filter((m) => m.id === 'exp-1');
    expect(progress.length).toBeGreaterThan(3);
    const phases = [...new Set(progress.map((m) => m.phase))];
    expect(phases[0]).toBe('prepare');
    expect(phases).toContain('render');
    const render = progress.filter((m) => m.phase === 'render');
    expect(render.at(-1).total).toBe(72 + 60);
    for (let i = 1; i < render.length; i++) expect(render[i].done).toBeGreaterThanOrEqual(render[i - 1].done);
    expect(new Set(render.map((m) => m.shotId))).toEqual(new Set([SHOT_A, SHOT_B]));
    // the last message of each phase goes: every frame rendered, every file read, then finish
    expect(render.at(-1).done).toBe(72 + 60);
    expect(progress.filter((m) => m.phase === 'encode').at(-1)).toMatchObject({ done: 6, total: 6 });
    expect(progress.at(-1).phase).toBe('finish');
    // at most one message every 100 ms, by the desk's own clock when it sent them (the host's clock
    // sees them with the stalls of its own event loop); a phase's last message goes at once when the
    // next phase starts, so it may follow the one before it sooner
    const sentAt: { id: string; phase: string; at: number }[] = (
      await frame.evaluate(() => (window as any).__desk.progressSent())
    ).filter((p: { id: string }) => p.id === 'exp-1');
    expect(sentAt.length).toBe(progress.length);
    for (let i = 1; i < sentAt.length; i++) {
      const lastOfPhase = i === sentAt.length - 1 || sentAt[i + 1].phase !== sentAt[i].phase;
      // 100 ms by the desk's Date.now, measured with performance.now: within 2 ms of it
      if (!lastOfPhase) expect(sentAt[i].at - sentAt[i - 1].at, `progress ${i}`).toBeGreaterThanOrEqual(98);
    }

    expect(result).toMatchObject({ id: 'exp-1', sceneId: EXAMPLE.id, fps: 24, width: 1280, height: 720 });
    expect(result.shots.map((s: any) => s.shotId)).toEqual([SHOT_A, SHOT_B]);
    const frames: Record<string, number> = { [SHOT_A]: 72, [SHOT_B]: 60 };
    for (const s of result.shots) {
      expect(s.frames).toBe(frames[s.shotId]);
      expect(s.durationSec).toBeCloseTo(frames[s.shotId] / 24, 9);
      expect(s.references).toEqual({ camera: `${s.shotId}.camera.mp4`, pose: `${s.shotId}.pose.mp4` });
      expect(s.still).toBe(`${s.shotId}.still.png`);
      expect(s.camera.lensMm).toBeGreaterThanOrEqual(8);
      expect(typeof s.line).toBe('string');
    }
    expect(result.files.map((f: any) => f.name).sort()).toEqual(
      [SHOT_A, SHOT_B].flatMap((id) => [`${id}.camera.mp4`, `${id}.pose.mp4`, `${id}.still.png`]).sort(),
    );
    for (const f of result.files) {
      const bytes = await fileBytes(page, f.name);
      // the host recorded the file as the desk sent it, in the fixtures' $bytes notation
      expect(Buffer.from(f.data.$bytes, 'base64').equals(Buffer.from(bytes)), f.name).toBe(true);
      if (f.name.endsWith('.mp4')) {
        expect(f.mime).toBe('video/mp4');
        const info = mp4Info(bytes);
        expect(info.order.indexOf('moov'), f.name).toBeLessThan(info.order.indexOf('mdat'));
        expect(info.codec).toBe('avc1');
        expect([info.width, info.height]).toEqual([1280, 720]);
        expect(info.samples, f.name).toBe(frames[f.name.split('.')[0]]);
        expect(info.sync[0]).toBe(1);
        expect(info.colr).toEqual({ type: 'nclx', primaries: 1, transfer: 1, matrix: 1, fullRange: false });
        expect(avcSps(info.avcC!).signal).toEqual({ fullRange: false, primaries: 1, transfer: 1, matrix: 1 });
        expect(new Set(info.durations).size).toBe(1);
        expect(info.timescale / info.durations[0]).toBeCloseTo(24, 6);
      } else {
        expect(f.mime).toBe('image/png');
        const png = readPng(bytes);
        expect([png.width, png.height, png.depth, png.colorType]).toEqual([1280, 720, 8, 2]);
      }
    }

    // the host's answer is shown
    await send(page, {
      type: 'result-ack',
      id: 'exp-1',
      ok: true,
      message: 'Imported 1 of 2 shots.',
      shots: [
        { shotId: SHOT_A, ok: true },
        { shotId: SHOT_B, ok: false, error: 'the clip is shorter than the shot' },
      ],
    });
    await expect(frame.getByTestId('desk-ack')).toContainText('Imported 1 of 2 shots.');
    await expect(frame.getByTestId('desk-ack-refused')).toContainText(SHOT_B);

    // save: a state with the same id, now
    await send(page, { type: 'save', id: 'save-1' });
    const states = await waitFor(page, 'state', 2);
    expect(states.at(-1)).toMatchObject({ id: 'save-1', sceneId: EXAMPLE.id, shots: 2 });

    // Done: a final state, then close done
    await frame.getByTestId('desk-done').click();
    const [close] = await waitFor(page, 'close', 1);
    expect(close).toEqual({ type: 'close', reason: 'done' });
    const all = await portMessages(page);
    const iClose = all.findIndex((m) => m.type === 'close');
    expect(all[iClose - 1].type).toBe('state');
    await expect(frame.getByTestId('desk-closed')).toBeVisible();

    await expectValidMessages(page);
    // nothing went to the network once the desk had loaded (its workers came from its cache)
    await expect.poll(() => net.all().every((e) => e.fromSw !== null)).toBe(true);
    expect(net.network()).toEqual([]);
    net.stop();
    console.log(
      `[desk-embed] ready ${readyMs} ms after the host page started loading; open (staging) ${openMs} ms; ` +
        `export camera+pose+stills ${exportMs} ms; first state ${revive(state).state.data.byteLength} bytes`,
    );
  });

  test('reopening: the host state, the local copy, a changed brief and Update shots', async ({ browser }) => {
    test.setTimeout(240_000);
    // a browser that stages the brief and hands the host its state
    const first = await browser.newContext();
    const a = await first.newPage();
    await openHost(a);
    await waitFor(a, 'ready');
    await send(a, { type: 'open', scene: EXAMPLE, state: null, options: OPTIONS });
    await waitFor(a, 'opened', 1, 180_000);
    await waitFor(a, 'state');
    const hostState = await a.evaluate(() => (window as any).host.state());
    expect(hostState).toMatchObject({ format: '3d-editor.desk-state', version: 1 });

    // the same browser, the desk opened again without a state: its local copy
    await a.evaluate(() => (window as any).host.mount());
    await waitFor(a, 'ready', 2);
    await send(a, { type: 'open', scene: EXAMPLE, state: null, options: OPTIONS });
    const openedA = await waitFor(a, 'opened', 2);
    expect(openedA[1]).toEqual({ type: 'opened', sceneId: EXAMPLE.id, source: 'local', changes: null });
    await expectValidMessages(a);
    await first.close();

    // another browser (no local copy) with the host's state: the state, with nothing to change
    const second = await browser.newContext();
    const b = await second.newPage();
    await openHost(b);
    await waitFor(b, 'ready');
    const tState = Date.now();
    await send(b, {
      type: 'open',
      scene: EXAMPLE,
      state: { format: hostState.format, version: 1, data: { $bytes: hostState.$bytes } },
      options: OPTIONS,
    });
    const [fromState] = await waitFor(b, 'opened', 1, 60_000);
    const fromStateMs = Date.now() - tState;
    expect(fromState).toEqual({ type: 'opened', sceneId: EXAMPLE.id, source: 'state', changes: null });
    let frame = await deskFrame(b);
    await expect(frame.getByTestId('desk-source')).toHaveAttribute('data-source', 'state');
    await expect(frame.getByTestId('desk-changes')).toHaveCount(0);
    expect(await frame.evaluate(() => (window as any).__desk.shots().length)).toBe(2);

    // a later brief of the scene (shot C added, shot B a second longer) with the same state: the
    // changes are listed, the staging stays until the person updates
    const changed = structuredClone(EXAMPLE);
    changed.shots[1].durationSec = 3.5;
    changed.shots.push({
      ...changed.shots[1],
      id: 'sht_0123456789cccc',
      index: 2,
      durationSec: 2,
      description: 'Medium: Pip barks at the pond.',
      action: '',
      castIds: ['chr_0123456789pipd'],
      elementIds: [],
      framing: 'medium',
      movement: 'static',
      move: null,
      lensMm: null,
      layout: [],
    });
    await b.evaluate(() => (window as any).host.mount());
    await waitFor(b, 'ready', 2);
    await send(b, {
      type: 'open',
      scene: changed,
      state: { format: hostState.format, version: 1, data: { $bytes: hostState.$bytes } },
      options: OPTIONS,
    });
    const opened = await waitFor(b, 'opened', 2, 60_000);
    expect(opened[1]).toEqual(fixture('opened-changed.json'));
    frame = await deskFrame(b);
    await expect(frame.getByTestId('desk-changes-text')).toHaveText('1 shot added, 1 shot retimed');
    expect(await frame.evaluate(() => (window as any).__desk.shots().length)).toBe(2);
    const statesBefore = (await ofType(b, 'state')).length;
    await frame.getByTestId('desk-update-shots').click();
    await expect(frame.getByTestId('desk-changes')).toHaveCount(0, { timeout: 60_000 });
    const shots = await frame.evaluate(() => (window as any).__desk.shots());
    expect(shots.map((x: any) => x.host)).toEqual([SHOT_A, SHOT_B, 'sht_0123456789cccc']);
    expect(shots.map((x: any) => x.frames)).toEqual([72, 84, 48]);
    // the update went to the host as a state (after the edit, within the 2 s quiet + 5 s spacing)
    const afterUpdate = await waitFor(b, 'state', statesBefore + 1, 20_000);
    expect(afterUpdate.at(-1)).toMatchObject({ sceneId: EXAMPLE.id, shots: 3 });
    expect(afterUpdate.at(-1).id).toBeUndefined();
    // one undo step takes it back
    await frame.evaluate(() => (window as any).__desk.run('ed.undo'));
    expect(await frame.evaluate(() => (window as any).__desk.shots().map((x: any) => x.frames))).toEqual([
      72, 60,
    ]);
    await expectValidMessages(b);
    console.log(`[desk-embed] opened from the host's state in a browser without a copy in ${fromStateMs} ms`);
    await second.close();
  });

  test('what the desk ignores or refuses', async ({ page }) => {
    test.setTimeout(180_000);
    await openHost(page);
    await waitFor(page, 'ready');
    // a desk connected first with a version it does not speak: refused on that port, then version 1
    await page.evaluate(() => (window as any).host.mount({ firstVersion: 2 }));
    await waitFor(page, 'ready', 2);
    const refused = (await allMessages(page)).filter((r) => r.bad).map((r) => r.message);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ type: 'error', code: 'unsupported_version' });

    const quiet = async () => {
      const n = (await allMessages(page)).length;
      await page.waitForTimeout(1500);
      expect((await allMessages(page)).slice(n)).toEqual([]);
    };
    // a connect from another frame of the page (not the desk's parent), a second connect from the
    // parent, an unknown type and a save without its id: nothing answers
    await page.evaluate(() => (window as any).host.connectFromSibling());
    await page.evaluate(() =>
      (window as any).host.postToDesk({ protocol: '3d-desk', type: 'connect', version: 1 }, true),
    );
    await page.evaluate(() => (window as any).host.postToDesk({ protocol: 'other', type: 'hello' }));
    await send(page, { type: 'frobnicate', id: 'x-1' });
    await send(page, { type: 'save' });
    await quiet();

    // known types that do not validate, and requests before the scene is open
    await send(page, fixture('invalid/export-unknown-mode.json'));
    await send(page, { type: 'export', id: 'early-1' });
    await send(page, { type: 'save', id: 'early-2' });
    await send(page, fixture('invalid/open-odd-width.json'));
    const errors = await waitFor(page, 'error', 4);
    expect(errors.map((e) => [e.id ?? null, e.code])).toEqual([
      [fixture('invalid/export-unknown-mode.json').id, 'bad_message'],
      ['early-1', 'not_open'],
      ['early-2', 'not_open'],
      [null, 'invalid_scene'],
    ]);

    // the scene opens; a second open is busy, an export of a shot it does not have a bad message,
    // a cancel of no export is ignored
    await send(page, { type: 'open', scene: smallBrief(), state: null });
    await waitFor(page, 'opened', 1, 120_000);
    await send(page, { type: 'open', scene: smallBrief(), state: null });
    await send(page, { type: 'export', id: 'nope-1', shots: ['sht_notinthisscene'] });
    await send(page, { type: 'cancel', id: 'nothing-runs' });
    const more = await waitFor(page, 'error', 6);
    expect(more.slice(4).map((e) => [e.id ?? null, e.code])).toEqual([
      [null, 'busy'],
      ['nope-1', 'bad_message'],
    ]);
    // the person closes the desk: close {cancel}
    const frame = await deskFrame(page);
    await frame.getByTestId('desk-close').click();
    const [close] = await waitFor(page, 'close');
    expect(close).toEqual({ type: 'close', reason: 'cancel' });
    // only hellos were posted on window, one per page load
    const posted = await page.evaluate(() => (window as any).host.windowMessages());
    expect(posted.map((m: any) => m.data.type)).toEqual(['hello', 'hello']);
    expect((await allMessages(page)).filter((r) => r.sibling || r.extra)).toEqual([]);
    await expectValidMessages(page);
  });

  test('a second desk on a scene another tab of the browser has open: its Close ends the wait', async ({
    page,
    context,
  }) => {
    test.setTimeout(240_000);
    const scene = smallBrief('clp_twodesks000001');
    await openHost(page);
    await waitFor(page, 'ready');
    await send(page, { type: 'open', scene, state: null, options: OPTIONS });
    await waitFor(page, 'opened', 1, 120_000);
    // another tab of the same host in this browser opens the same scene: its desk waits for the first
    const second = await context.newPage();
    await openHost(second);
    await waitFor(second, 'ready');
    await send(second, { type: 'open', scene, state: null, options: OPTIONS });
    const frame = await deskFrame(second);
    await expect(frame.getByTestId('desk-work')).toContainText('open in another tab', { timeout: 60_000 });
    // the person presses the desk's Close: the wait ends, close goes, and nothing after it
    await frame.getByTestId('desk-work-close').click();
    const [close] = await waitFor(second, 'close');
    expect(close).toEqual({ type: 'close', reason: 'cancel' });
    await expect(frame.getByTestId('desk-work')).toHaveCount(0);
    await expect(frame.getByTestId('desk-closed')).toBeVisible();
    // the host opens another scene in that frame: it opens at once, and the first tab keeps its own
    await send(second, {
      type: 'open',
      scene: smallBrief('clp_twodesks000002'),
      state: null,
      options: OPTIONS,
    });
    await waitFor(second, 'state', 1, 120_000);
    expect((await portMessages(second)).map((m) => m.type)).toEqual(['ready', 'close', 'opened', 'state']);
    expect((await ofType(second, 'opened'))[0]).toMatchObject({ sceneId: 'clp_twodesks000002' });
    await expect((await deskFrame(page)).getByTestId('desk-app')).toHaveAttribute('data-status', 'open');
    expect((await portMessages(page)).map((m) => m.type)).not.toContain('close');
    await expectValidMessages(second);
    await second.close();
  });

  test("Close while a long brief stages: the staging stops, the closed panel is the desk's at once, nothing is kept", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openHost(page);
    await waitFor(page, 'ready');
    const scene = longBrief('clp_closestaging001', 120);
    await send(page, { type: 'open', scene, state: null, options: OPTIONS });
    const frame = await deskFrame(page);
    await expect(frame.getByTestId('desk-work')).toContainText('Staging 120 shots', { timeout: 60_000 });
    await frame.getByTestId('desk-work-close').click();
    const [close] = await waitFor(page, 'close');
    expect(close).toEqual({ type: 'close', reason: 'cancel' });
    // at once: no work over the closed panel, whose Back to the desk is the element at its centre
    // (staging these 120 shots takes seconds: it is stopped, not waited for)
    await expect(frame.getByTestId('desk-work')).toHaveCount(0, { timeout: 1_000 });
    await expect(frame.getByTestId('desk-closed')).toBeVisible();
    const backOnTop = await frame.evaluate(() => {
      const back = [...document.querySelectorAll('[data-testid="desk-closed"] button')].find((b) =>
        /Back to the desk/.test(b.textContent ?? ''),
      )!;
      const r = back.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!hit && back.contains(hit);
    });
    expect(backOnTop).toBe(true);
    // the host opens the scene again: staged anew (the cancelled staging left no local copy)
    await send(page, { type: 'open', scene, state: null, options: OPTIONS });
    const [opened] = await waitFor(page, 'opened', 1, 120_000);
    expect(opened).toMatchObject({ sceneId: scene.id, source: 'brief' });
    expect((await portMessages(page)).map((m) => m.type).slice(0, 3)).toEqual(['ready', 'close', 'opened']);
    await expectValidMessages(page);
  });

  test('a shot made longer in the desk: Send warns, the clip goes with its issue', async ({ page }) => {
    test.setTimeout(240_000);
    await openHost(page);
    await waitFor(page, 'ready');
    await send(page, {
      type: 'open',
      scene: smallBrief(),
      state: null,
      options: { hostName: 'rideo', modes: ['camera'] },
    });
    await waitFor(page, 'opened', 1, 120_000);
    const states = (await waitFor(page, 'state')).length;
    const frame = await deskFrame(page);
    const shotB = await frame.evaluate(
      (id) => (window as any).__desk.shots().find((x: any) => x.host === id).id,
      SHOT_B,
    );
    const tEdit = Date.now();
    const r = await frame.evaluate(
      (id) => (window as any).__desk.run('desk.shot_update', { shot: id, duration_s: 1 }),
      shotB,
    );
    expect(r.ok, r.error).toBe(true);
    // the edit goes to the host as a state about 2 s later
    const after = await waitFor(page, 'state', states + 1, 15_000);
    expect(Date.now() - tEdit).toBeGreaterThan(1500);
    expect(after.at(-1)).toMatchObject({ shots: 2 });
    await expect(frame.getByTestId('desk-source')).toHaveAttribute('data-source', 'brief');

    await frame.getByTestId('desk-send').click();
    // made longer here, not by the brief: no Update shots, and the host refuses its clip
    await expect(frame.getByTestId('desk-send-check-desk')).toContainText(SHOT_B);
    await expect(frame.getByTestId('desk-send-check-brief')).toHaveCount(0);
    await expect(frame.getByTestId('desk-send-check-update')).toHaveCount(0);
    await frame.getByTestId('desk-send-check-send').click();
    const [result] = await waitFor(page, 'result', 1, 180_000);
    expect(result.id).toBe('desk-1');
    expect(result.shots.map((x: any) => [x.shotId, x.frames])).toEqual([
      [SHOT_A, 12],
      [SHOT_B, 24],
    ]);
    expect(result.shots[0].issues.filter((i: any) => i.code === 'brief_length')).toEqual([]);
    expect(result.shots[1].issues.find((i: any) => i.code === 'brief_length')).toMatchObject({
      severity: 'error',
      message: expect.stringContaining('Set its length back'),
    });
    expect(result.files.map((f: any) => f.name).sort()).toEqual(
      [`${SHOT_A}.camera.mp4`, `${SHOT_A}.still.png`, `${SHOT_B}.camera.mp4`, `${SHOT_B}.still.png`].sort(),
    );
    expect(mp4Info(await fileBytes(page, `${SHOT_B}.camera.mp4`)).samples).toBe(24);
    await expectValidMessages(page);
  });

  test("Follow and Send; the viewport's keys only over the viewport; a brief over the export's size; the wake lock", async ({
    page,
  }) => {
    test.setTimeout(360_000);
    /** Counts a frame's wake lock requests and the permissions policy violations reported to it. */
    const watchWakeLock = (f: Frame) =>
      f.evaluate(() => {
        const w = window as any;
        const seen = (w.__wakeLockSeen = { requests: 0, violations: [] as string[] });
        const proto = w.WakeLock?.prototype;
        const request = proto?.request;
        if (request)
          proto.request = function (this: unknown, ...args: unknown[]) {
            seen.requests++;
            return request.apply(this, args);
          };
        new w.ReportingObserver(
          (reports: { type: string; body?: { featureId?: string } }[]) => {
            for (const r of reports) seen.violations.push(`${r.type}: ${r.body?.featureId ?? ''}`);
          },
          { types: ['permissions-policy-violation'], buffered: true },
        ).observe();
      });
    const wakeLockSeen = (f: Frame) =>
      f.evaluate(() => (window as any).__wakeLockSeen as { requests: number; violations: string[] });
    const policyLog: string[] = [];
    page.on('console', (m) => {
      if (/permissions policy/i.test(m.text())) policyLog.push(m.text());
    });
    await openHost(page);
    await waitFor(page, 'ready');
    const frame = await deskFrame(page);
    // the host's frame allows screen-wake-lock (as docs/embedding.md shows): an export asks to keep
    // the screen on (headless Chromium then refuses the permission, which is no policy violation)
    expect(await frame.evaluate(() => typeof (navigator as any).wakeLock)).toBe('object');
    await watchWakeLock(frame);
    await send(page, {
      type: 'open',
      scene: smallBrief(),
      state: null,
      options: { hostName: 'rideo', modes: ['pose', 'camera'], defaultMode: 'camera' },
    });
    await waitFor(page, 'opened', 1, 120_000);
    await waitFor(page, 'state');
    // Follow lists the host's modes in its order, its defaultMode chosen; the header says where
    // the state went
    const follow = frame.getByTestId('desk-mode');
    await expect(follow.locator('option')).toHaveText(['Pose', 'Camera']);
    await expect(follow).toHaveValue('camera');
    await expect(frame.getByTestId('desk-state-sent')).toContainText('Sent to rideo');

    // the viewport's keys act over the viewport only: not over the shot list or the header
    const objects = () => frame.evaluate(() => (window as any).__desk.objects() as number);
    // a click gives the frame the keyboard (keys go to the focused frame), then select everything
    await frame.getByTestId('viewport').click();
    await page.keyboard.press('a');
    const n = await objects();
    expect(n).toBeGreaterThan(0);
    await frame.getByTestId('desk-side').hover();
    await page.keyboard.press('Delete');
    await page.keyboard.press('x');
    await frame.getByTestId('desk-header').hover();
    await page.keyboard.press('Delete');
    expect(await objects()).toBe(n);
    await frame.getByTestId('viewport').hover();
    await page.keyboard.press('Delete');
    await expect.poll(objects).toBeLessThan(n);
    await page.keyboard.press('Control+z');
    await expect.poll(objects).toBe(n);

    // Send renders the mode Follow shows, with stills
    await follow.selectOption('pose');
    await frame.getByTestId('desk-send').click();
    const [result] = await waitFor(page, 'result', 1, 180_000);
    expect(result.id).toBe('desk-1');
    expect(result.shots.map((x: any) => Object.keys(x.references))).toEqual([['pose'], ['pose']]);
    expect(result.files.map((f: any) => f.name).sort()).toEqual(
      [`${SHOT_A}.pose.mp4`, `${SHOT_A}.still.png`, `${SHOT_B}.pose.mp4`, `${SHOT_B}.still.png`].sort(),
    );
    await expectValidMessages(page);
    expect((await wakeLockSeen(frame)).requests).toBeGreaterThan(0);

    // a frame without screen-wake-lock: an export there never asks for the wake lock, so the browser
    // reports no permissions policy violation (the export engine reads the frame's policy)
    await page.evaluate(() => (window as any).host.mount({ allow: 'fullscreen; clipboard-write' }));
    await waitFor(page, 'ready', 2, 30_000);
    const second = await deskFrame(page);
    await watchWakeLock(second);
    await send(page, {
      type: 'open',
      scene: smallBrief('clp_small0000000002'),
      state: null,
      options: { hostName: 'rideo', modes: ['camera'] },
    });
    await waitFor(page, 'opened', 2, 120_000);
    await send(page, { type: 'export', id: 'nolock-1', shots: [SHOT_A], modes: ['camera'], still: false });
    const results = await waitFor(page, 'result', 2, 180_000);
    expect(results.at(-1).id).toBe('nolock-1');
    expect(await wakeLockSeen(second)).toEqual({ requests: 0, violations: [] });
    expect(policyLog).toEqual([]);
    // (a request there would be refused, and reported as one)
    expect(
      await second.evaluate(() =>
        (navigator as any).wakeLock.request('screen').then(
          () => 'granted',
          (e: Error) => e.name,
        ),
      ),
    ).toBe('NotAllowedError');
    await expect
      .poll(async () => (await wakeLockSeen(second)).violations)
      .toEqual(['permissions-policy-violation: screen-wake-lock']);
    // a portrait brief over 2160 pixels high: said when it opens, Send off, an export refused at once
    // (in a new frame: one open per connection)
    await page.evaluate(() => (window as any).host.mount());
    await waitFor(page, 'ready', 3, 30_000);
    const third = await deskFrame(page);
    const tall = smallBrief('clp_tall0000000001');
    tall.width = 2160;
    tall.height = 3840;
    await send(page, { type: 'open', scene: tall, state: null, options: { hostName: 'rideo' } });
    await waitFor(page, 'opened', 3, 120_000);
    await expect(third.getByTestId('desk-notice')).toContainText('too high');
    await expect(third.getByTestId('desk-send')).toBeDisabled();
    await send(page, { type: 'export', id: 'tall-1' });
    await expect
      .poll(async () => (await ofType(page, 'error')).find((e) => e.id === 'tall-1')?.code, {
        timeout: 10_000,
      })
      .toBe('export_unavailable');
    await expectValidMessages(page);
  });

  test('read-only: view, play and export only', async ({ page }) => {
    test.setTimeout(180_000);
    await openHost(page);
    await waitFor(page, 'ready');
    await send(page, { type: 'open', scene: smallBrief(), state: null, options: { readOnly: true } });
    await waitFor(page, 'opened', 1, 120_000);
    const frame = await deskFrame(page);
    await expect(frame.getByTestId('desk-read-only')).toBeVisible();
    await expect(frame.getByTestId('desk-send')).toContainText('Send to the host');
    const shotB = await frame.evaluate(
      (id) => (window as any).__desk.shots().find((x: any) => x.host === id).id,
      SHOT_B,
    );
    const r = await frame.evaluate(
      (id) => (window as any).__desk.run('desk.shot_update', { shot: id, duration_s: 1 }),
      shotB,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('read-only');
    expect(await frame.evaluate(() => (window as any).__desk.shots().map((x: any) => x.frames))).toEqual([
      12, 12,
    ]);
    // the editor's keys for the chrome the desk hides do nothing (a click gives the frame the
    // keyboard: keys go to the focused frame)
    await frame.getByTestId('viewport').click();
    for (const key of ['F3', 'Control+o', 'Control+n', 'Control+,', 'F1']) await page.keyboard.press(key);
    await expect(frame.locator('.palette')).toHaveCount(0);
    await expect(frame.locator('.dialog')).toHaveCount(0);
    // exports still run
    await send(page, { type: 'export', id: 'ro-1', shots: [SHOT_A], modes: ['camera'], still: false });
    const [result] = await waitFor(page, 'result', 1, 120_000);
    expect(result.shots.map((x: any) => x.shotId)).toEqual([SHOT_A]);
    expect(result.files.map((f: any) => f.name)).toEqual([`${SHOT_A}.camera.mp4`]);
    await expectValidMessages(page);
  });

  test('offline: the desk loads from its cache, stages and exports with no network', async ({
    page,
    context,
  }) => {
    test.setTimeout(240_000);
    await openHost(page);
    await waitFor(page, 'ready');
    await deskControlled(await deskFrame(page));
    await context.setOffline(true);
    try {
      // the host frames the desk again: desk.html, its scripts and workers come from the cache
      await page.evaluate(() => (window as any).host.mount());
      const ready = await waitFor(page, 'ready', 2, 60_000);
      expect(ready[1].capabilities.export.available).toBe(true);
      await send(page, { type: 'open', scene: smallBrief('clp_offline00000001'), state: null });
      const [opened] = await waitFor(page, 'opened', 1, 120_000);
      expect(opened.source).toBe('brief');
      await waitFor(page, 'state');
      await send(page, { type: 'export', id: 'off-1' });
      const [result] = await waitFor(page, 'result', 1, 180_000);
      expect(result.shots.map((x: any) => [x.shotId, x.frames])).toEqual([
        [SHOT_A, 12],
        [SHOT_B, 12],
      ]);
      const info = mp4Info(await fileBytes(page, `${SHOT_A}.camera.mp4`));
      expect([info.samples, info.width, info.height]).toEqual([12, 320, 180]);
      await expectValidMessages(page);
    } finally {
      await context.setOffline(false);
    }
  });

  test('on a phone: the header and the shots fit 390 × 844', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await openHost(page);
    await waitFor(page, 'ready');
    // three modes: Follow shows
    await send(page, { type: 'open', scene: smallBrief(), state: null, options: OPTIONS });
    await waitFor(page, 'opened', 1, 120_000);
    await waitFor(page, 'state');
    const frame = await deskFrame(page);
    // the header's note says where the state went (the longest the header gets)
    await expect(frame.getByTestId('desk-state-sent')).toBeVisible();
    for (const id of [
      'desk-scene-name',
      'desk-mode',
      'desk-send',
      'desk-done',
      'desk-close',
      'viewport',
      'bottom-tab-shots',
    ])
      await expect(frame.getByTestId(id)).toBeVisible();
    await expect(frame.getByTestId('director-panel')).toBeHidden();
    // Follow, Send, Done and Close on one line within the width
    const header = (await frame.getByTestId('desk-header').boundingBox())!;
    for (const id of ['desk-mode', 'desk-send', 'desk-done', 'desk-close']) {
      const box = (await frame.getByTestId(id).boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y + box.height).toBeLessThanOrEqual(header.y + header.height);
    }
    await expect(frame.getByTestId('desk-mode')).toHaveValue('camera');
    expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await frame.getByTestId('bottom-tab-shots').click();
    await expect(frame.locator('[data-testid="shot-list"]:visible')).toHaveCount(1);
  });

  test('on a phone of 360 px, with the longest host and scene names: Done and Close stay in the frame', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 360, height: 740 });
    await openHost(page);
    await waitFor(page, 'ready');
    // the longest names the contract allows: the host's (40 characters, on Send) and the scene's
    // (200); three modes, so Follow shows too
    const hostName = 'Storyboard Studio Online for Film Crews!';
    expect(hostName).toHaveLength(40);
    const scene = smallBrief('clp_phonehostname01');
    scene.name = 'The long walk up the windy hill, kites in hand, '.repeat(5).slice(0, 199) + '!';
    expect(scene.name).toHaveLength(200);
    await send(page, { type: 'open', scene, state: null, options: { ...OPTIONS, hostName } });
    await waitFor(page, 'opened', 1, 120_000);
    await waitFor(page, 'state');
    const frame = await deskFrame(page);
    await expect(frame.getByTestId('desk-state-sent')).toBeVisible();
    // Follow, Send, Done and Close on the header's line, inside the frame, each the element at its centre
    const header = (await frame.getByTestId('desk-header').boundingBox())!;
    const inFrame = await frame.evaluate(
      (ids) => {
        const out: Record<string, { right: number; bottom: number; top: boolean }> = {};
        for (const id of ids) {
          const el = document.querySelector(`[data-testid="${id}"]`)!;
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          out[id] = { right: r.right, bottom: r.bottom, top: !!hit && (el === hit || el.contains(hit)) };
        }
        return { out, width: innerWidth, scroll: document.documentElement.scrollWidth };
      },
      ['desk-mode', 'desk-send', 'desk-done', 'desk-close'],
    );
    expect(inFrame.width).toBe(360);
    expect(inFrame.scroll).toBeLessThanOrEqual(360);
    for (const [id, box] of Object.entries(inFrame.out)) {
      expect(box.right, id).toBeLessThanOrEqual(360);
      expect(box.bottom, id).toBeLessThanOrEqual(header.y + header.height);
      expect(box.top, `${id} is the element at its centre`).toBe(true);
    }
    // Send says just "Send" here; the host's name stays in its title and accessible name
    await expect(frame.getByTestId('desk-send-label')).toHaveText(`Send to ${hostName}`);
    expect(await frame.getByTestId('desk-send-label').evaluate((e) => (e as HTMLElement).innerText)).toBe(
      'Send',
    );
    await expect(frame.getByTestId('desk-send')).toHaveAttribute('aria-label', `Send to ${hostName}`);
    await expect(frame.getByTestId('desk-send')).toHaveAttribute(
      'title',
      new RegExp(`send them to ${hostName}`),
    );
    // the scene's name is cut short in what the actions leave of the header (its tooltip has it all)
    await expect(frame.getByTestId('desk-scene-name')).toHaveAttribute('title', scene.name);
    const name = await frame
      .getByTestId('desk-scene-name')
      .evaluate((e) => ({ full: e.scrollWidth, shown: e.clientWidth }));
    expect(name.full).toBeGreaterThan(name.shown);
    // Close works from there
    await frame.getByTestId('desk-close').click();
    const [close] = await waitFor(page, 'close');
    expect(close).toEqual({ type: 'close', reason: 'cancel' });
    await expect(frame.getByTestId('desk-closed')).toBeVisible();
    await expectValidMessages(page);
  });

  test("on a 1024 px screen, with the longest host and scene names: the notes give way as the scene's name does, never to less than their first word", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1024, height: 768 });
    await openHost(page);
    await waitFor(page, 'ready');
    const hostName = 'Storyboard Studio Online for Film Crews!';
    const scene = smallBrief('clp_widehostname001');
    scene.name = 'The long walk up the windy hill, kites in hand, '.repeat(5).slice(0, 199) + '!';
    await send(page, { type: 'open', scene, state: null, options: { ...OPTIONS, hostName } });
    await waitFor(page, 'opened', 1, 120_000);
    await waitFor(page, 'state');
    const frame = await deskFrame(page);
    await expect(frame.getByTestId('desk-state-sent')).toBeVisible();
    const header = await frame.evaluate(notesInHeader, { ids: ['desk-source', 'desk-state-sent'] });
    // the scene's name and both notes are cut short, the name keeping the most room; each note still
    // shows its first word ("Staged", "Sent"), and its tooltip has it whole
    expect(header.name.full).toBeGreaterThan(header.name.shown);
    for (const [id, note] of Object.entries(header.notes)) {
      expect(note.full, `${id} is cut short`).toBeGreaterThan(note.shown);
      expect(note.shown, `${id} shows its first word`).toBeGreaterThanOrEqual(note.word);
      expect(header.name.shown, `the name has more room than ${id}`).toBeGreaterThan(note.shown);
    }
    expect(header.notes['desk-source'].title).toBe('Staged from the brief');
    expect(header.notes['desk-state-sent'].title).toMatch(`The scene's state went to ${hostName}`);
    expect(header.closeRight).toBeLessThanOrEqual(1024);
    // after an edit the note says the host does not have it yet (until the state goes, 2 s after
    // the edit): cut short the same way, whole in its tooltip
    const shot = await frame.evaluate(() => (window as any).__desk.shots()[1].id);
    const r = await frame.evaluate(
      (id) => (window as any).__desk.run('desk.shot_update', { shot: id, duration_s: 1 }),
      shot,
    );
    expect(r.ok, r.error).toBe(true);
    const edited = await frame.evaluate(notesInHeader, { ids: ['desk-state-unsent'], wait: true });
    const unsent = edited.notes['desk-state-unsent'];
    expect(unsent.full).toBeGreaterThan(unsent.shown);
    expect(unsent.shown).toBeGreaterThanOrEqual(unsent.word);
    expect(unsent.title).toBe(`Changes not sent to ${hostName} yet`);
    expect(edited.name.shown).toBeGreaterThan(unsent.shown);
    await expectValidMessages(page);
  });

  test('on its own: the explanation, the editor link and the sample scene', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(DESK_URL);
    await expect(page.getByTestId('desk-standalone')).toBeVisible();
    await expect(page.getByTestId('desk-full-editor')).toHaveAttribute('href', '/');
    expect(await page.evaluate(() => document.querySelector('link[rel=manifest]'))).toBeNull();
    await page.getByTestId('desk-try-sample').click();
    await expect(page.getByTestId('desk-app')).toHaveAttribute('data-status', 'open', { timeout: 120_000 });
    await expect(page.getByTestId('desk-sample-bar')).toBeVisible();
    await expect(page.getByTestId('desk-scene-name')).toHaveText(EXAMPLE.name);
    expect(await page.evaluate(() => (window as any).__desk.shots().length)).toBe(2);
    // the editor's preferences are not the desk's to write
    expect(await page.evaluate(() => localStorage.getItem('3d-editor:prefs:v1'))).toBeNull();
  });
});
