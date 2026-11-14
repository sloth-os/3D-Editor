import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { menuPath, newProject, setNumberField } from './helpers';
import { avcSps, mp4Info, readPng, readZip } from '../../apps/web/test/export-files';

/*
 * The browser video export end to end, with no editor server at all: the production build of the
 * web app served as static files, a project kept in the browser with two desk shots, exported
 * from the Export Video window on this device (render workers + WebCodecs in headless Chromium)
 * as a 160×90 draft with a mask pass. The files are read back from the page: each clip's frame
 * count from its MP4 sample table, a key frame first, the BT.709 limited colour box and the same
 * tags in the H.264 stream's VUI, the index before the media, the mask frames as indexed PNGs, the
 * manifest's files with their SHA-256 and the one-download zip. The frames the render workers
 * rendered are checked against core rendering the same snapshot in Node (the server's render
 * processes run that code): their raw passes are the same bytes.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '../..');
const dist = resolve(root, 'apps/web/dist');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

/** A static file server of the built app (index.html for anything that is not a file). */
async function serveStatic(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    void (async () => {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      let file = normalize(join(dist, path));
      if (!file.startsWith(dist)) {
        res.writeHead(403).end();
        return;
      }
      const s = await stat(file).catch(() => null);
      if (!s || s.isDirectory()) file = join(dist, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    })().catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The bytes behind a link of the page (a blob: URL), read in the page. */
async function linkBytes(page: Page, testId: string): Promise<Uint8Array> {
  const href = await page.getByTestId(testId).getAttribute('href');
  expect(href).toMatch(/^blob:/);
  const b64 = await page.evaluate(async (url) => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, href!);
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

interface Frame {
  digests: Record<string, string>;
  meta: unknown;
}

interface EditorHook {
  run(id: string, params?: unknown): { ok: boolean; error?: string } | null;
  snapshot(): Uint8Array | null;
  export: { collectFrames(on: boolean): void; frames(): Record<string, Frame> };
}

/** Whether two JSON values are equal, numbers within 1e-9 (V8 versions round some Math functions differently). */
function nearlyEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number')
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => nearlyEqual(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return (
      nearlyEqual(ka, kb) &&
      ka.every((k) => nearlyEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    );
  }
  return a === b;
}

test.describe('browser video export (no server)', () => {
  let server: Server;
  let base: string;
  test.beforeAll(async () => {
    ({ server, base } = await serveStatic());
  });
  test.afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  test('exports two shots on this device, frame for frame what core renders', async ({ page }) => {
    test.setTimeout(150_000);
    await newProject(page, base);
    const shots = await page.evaluate(() => {
      const e = (window as unknown as { __editor: EditorHook }).__editor;
      const results = [
        e.run('desk.shot_add', {
          name: 'Wide',
          camera: 'Camera',
          frame_start: 1,
          frame_end: 4,
          solve: false,
        }),
        e.run('desk.shot_add', {
          name: 'Close',
          camera: 'Camera',
          frame_start: 5,
          frame_end: 7,
          solve: false,
        }),
      ];
      e.export.collectFrames(true);
      return results.map((r) => r?.ok ?? false);
    });
    expect(shots).toEqual([true, true]);

    await menuPath(page, ['Render', 'Export Video…']);
    await expect(page.getByTestId('export-video-dialog')).toBeVisible();
    // no server: this device only
    await expect(page.getByTestId('export-video-where')).toHaveCount(0);
    await expect(page.getByTestId('export-video-browser-unsupported')).toHaveCount(0);
    await page.getByTestId('export-video-resolution').selectOption('custom');
    await setNumberField(page, 'export-video-width', 160);
    await setNumberField(page, 'export-video-height', 90);
    await page.getByTestId('export-video-quality-draft').click();
    await page.getByTestId('export-video-pass-mask').click();
    await expect(page.getByTestId('export-video-estimate')).toContainText('7 frames');
    await expect(page.getByTestId('export-video-start')).toBeEnabled();
    await page.getByTestId('export-video-start').click();
    await expect(page.getByTestId('export-video-job')).toHaveAttribute('data-where', 'device');
    await expect(page.getByTestId('export-video-files')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('export-video-status')).toContainText('Done: 7 frames');
    await expect(page.getByTestId('export-video-preview')).toBeVisible();

    const names = await page
      .locator('[data-testid^="export-video-file-"]')
      .evaluateAll((els) =>
        els.map((e) => (e as HTMLElement).dataset.testid!.replace('export-video-file-', '')),
      );
    const files = new Map<string, Uint8Array>();
    for (const name of names) files.set(name, await linkBytes(page, `export-video-file-${name}`));
    const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')!));
    const [wide, close] = manifest.shots as { id: string; files: { name: string }[] }[];
    expect(manifest).toMatchObject({
      width: 160,
      height: 90,
      frames: 7,
      codec: 'h264',
      exporter: { kind: 'browser' },
    });

    // clips: their frames, a key frame first, BT.709 limited in the colour box and in the stream
    const clips = (
      manifest.files as { name: string; kind: string; pass?: string; shot?: string; frames?: number }[]
    ).filter((f) => f.kind === 'clip' && f.pass === 'beauty');
    expect(clips.map((c) => [c.shot, c.frames])).toEqual([
      [wide.id, 4],
      [close.id, 3],
    ]);
    for (const c of clips) {
      const info = mp4Info(files.get(c.name)!);
      expect(info.samples, c.name).toBe(c.frames);
      expect(info.sync[0], c.name).toBe(1);
      expect(info.order, c.name).toEqual(['ftyp', 'moov', 'mdat']);
      expect(info.colr, c.name).toEqual({
        type: 'nclx',
        primaries: 1,
        transfer: 1,
        matrix: 1,
        fullRange: false,
      });
      expect([info.width, info.height], c.name).toEqual([160, 90]);
      expect(avcSps(info.avcC!).signal, c.name).toEqual({
        fullRange: false,
        primaries: 1,
        transfer: 1,
        matrix: 1,
      });
    }
    const seq = mp4Info(files.get('sequence.mp4')!);
    expect(seq.samples).toBe(7);
    expect(seq.sync.slice(0, 2)).toEqual([1, 5]);
    expect(mp4Info(files.get('sequence.mask.mp4')!).samples).toBe(7);

    // the mask frames: indexed PNGs, one per frame
    const zip = readZip(files.get('sequence.mask.zip')!);
    expect(zip.map((z) => z.name)).toEqual(
      Array.from({ length: 7 }, (_, i) => `frame-${String(i + 1).padStart(6, '0')}.png`),
    );
    for (const z of zip) expect(readPng(z.data).colorType).toBe(3);

    // the manifest lists every file (but itself) with the bytes' SHA-256
    for (const f of manifest.files as { name: string; bytes: number; sha256: string }[]) {
      expect(files.get(f.name), f.name).toBeDefined();
      expect(f.bytes, f.name).toBe(files.get(f.name)!.length);
      expect(f.sha256, f.name).toBe(sha256(files.get(f.name)!));
    }
    expect([...files.keys()].sort()).toEqual(
      [...(manifest.files as { name: string }[]).map((f) => f.name), 'manifest.json'].sort(),
    );

    // one zip of all
    const download = page.waitForEvent('download');
    await page.getByTestId('export-video-download-all').click();
    const d = await download;
    expect(d.suggestedFilename()).toMatch(/-export\.zip$/);
    const all = readZip(new Uint8Array(await readFile(await d.path())));
    expect(all.map((e) => e.name).sort()).toEqual([...files.keys()].sort());
    for (const e of all) expect(sha256(e.data), e.name).toBe(sha256(files.get(e.name)!));

    // parity: the raw passes the render workers rendered are core's in Node, byte for byte, and
    // so is the metadata (to the last bits of Math functions, which V8 versions round differently)
    const { frames, update } = await page.evaluate(() => {
      const e = (window as unknown as { __editor: EditorHook }).__editor;
      return { frames: e.export.frames(), update: Array.from(e.snapshot()!) };
    });
    expect(Object.keys(frames)).toHaveLength(7);
    const params = {
      shots: 'all',
      width: 160,
      height: 90,
      quality: 'draft',
      look: 'material',
      passes: ['beauty', 'mask'],
    };
    const node = JSON.parse(
      execFileSync(
        process.execPath,
        ['--import', 'tsx', join(root, 'e2e/fixtures/export-parity.ts'), JSON.stringify(params)],
        {
          cwd: root,
          input: Buffer.from(update),
          maxBuffer: 16 * 1024 * 1024,
        },
      ).toString(),
    ) as Record<string, Frame>;
    expect(Object.keys(node).sort()).toEqual(Object.keys(frames).sort());
    for (const [key, f] of Object.entries(frames)) {
      expect(Object.keys(f.digests).sort(), key).toEqual(['beauty', 'mask']);
      expect(f.digests, key).toEqual(node[key].digests);
      expect(f.meta, key).toBeTruthy();
      expect(nearlyEqual(f.meta, node[key].meta), key).toBe(true);
    }
  });
});
