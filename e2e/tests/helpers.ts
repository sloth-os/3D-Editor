import { inflateSync } from 'node:zlib';
import { expect, type Page, type BrowserContext } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const PLAIN = 'http://127.0.0.1:4180';
export const DAV_SERVER = 'http://127.0.0.1:4181';
export const WEBDAV = { url: 'http://127.0.0.1:4199', username: 'editor', password: 'secret' };

/** Opens the app and creates a new project with the default scene; returns its id. */
export async function newProject(page: Page, base = PLAIN, opts: { empty?: boolean } = {}): Promise<string> {
  await page.goto(`${base}/`);
  await page.getByTestId(opts.empty ? 'new-empty-project' : 'new-project').click();
  await expect(page.getByTestId('viewport')).toBeVisible();
  await page.waitForFunction(() => new URL(location.href).searchParams.has('project'));
  const id = new URL(page.url()).searchParams.get('project')!;
  if (!opts.empty) await expect(page.getByTestId('outliner-Cube')).toBeVisible();
  return id;
}

export async function openProject(page: Page, base: string, id: string): Promise<void> {
  await page.goto(`${base}/?project=${id}`);
  await expect(page.getByTestId('viewport')).toBeVisible();
}

export async function outlinerNames(page: Page): Promise<string[]> {
  const rows = page.locator('[data-testid^="outliner-"]:not([data-testid^="outliner-vis-"])');
  const ids = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.testid ?? ''));
  return ids.filter((x) => x !== 'outliner').map((x) => x.replace(/^outliner-/, ''));
}

/** Runs an operator through the F3 search palette (real UI path). */
export async function runFromPalette(page: Page, query: string, label: string): Promise<void> {
  await page.getByTestId('viewport').hover();
  await page.keyboard.press('F3');
  await page.getByTestId('palette-input').fill(query);
  await page.locator('.palette .result', { hasText: label }).first().click();
}

/** Uses a menu path in the viewport header, e.g. ['Add', 'Mesh', 'UV Sphere']. */
export async function menuPath(page: Page, path: string[]): Promise<void> {
  await page.getByTestId(`menu-button-${path[0].toLowerCase()}`).first().click();
  for (let i = 1; i < path.length; i++) {
    const item = page
      .locator('.menu .menu-item', { hasText: new RegExp(`^\\s*${escapeRe(path[i])}`) })
      .first();
    if (i < path.length - 1) await item.hover();
    else await item.click();
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function statNumber(page: Page, testId: string): Promise<number> {
  const t = (await page.getByTestId(testId).textContent()) ?? '';
  return Number(t.replace(/[^\d]/g, ''));
}

/** The number shown by a field (e.g. "-12.702 m", "28.648°", "Z 0.5"). */
export async function fieldNumber(page: Page, testId: string): Promise<number> {
  const t = (await page.getByTestId(testId).textContent()) ?? '';
  const m = /-?\d+(?:\.\d+)?/.exec(t.replace(/,/g, ''));
  return m ? Number(m[0]) : NaN;
}

/** Types a value into a Blender-style number field (click, type, Enter), like a user. */
export async function setNumberField(page: Page, testId: string, value: string | number): Promise<void> {
  const field = page.getByTestId(testId);
  await field.click();
  const input = field.locator('input');
  await input.fill(String(value));
  await input.press('Enter');
  await expect(input).toHaveCount(0);
}

export async function mcpConnect(
  base: string,
  opts: { agentId?: string; agentIdVia?: 'header' | 'query'; name?: string } = {},
): Promise<Client> {
  const client = new Client({ name: opts.name ?? 'e2e-agent', version: '1.0.0' });
  const url = new URL(`${base}/mcp`);
  const headers: Record<string, string> = {};
  if (opts.agentId) {
    if (opts.agentIdVia === 'query') url.searchParams.set('agent', opts.agentId);
    else headers['x-mcp-agent-id'] = opts.agentId;
  }
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
}

/** Ends an MCP session like a one-shot CLI does (HTTP DELETE), then closes the client. */
export async function mcpEndSession(client: Client): Promise<void> {
  const transport = client.transport as StreamableHTTPClientTransport | undefined;
  await transport?.terminateSession();
  await client.close();
}

interface ToolResult {
  content?: { type: string; text?: string; data?: string; mimeType?: string; resource?: any }[];
  isError?: boolean;
}

/** Parses the JSON text content of an MCP tool result. */
export function toolJson<T = any>(res: unknown): T {
  const r = res as ToolResult;
  if (r.isError) throw new Error(`tool error: ${r.content?.map((c) => c.text).join('\n')}`);
  const text = r.content?.find((c) => c.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as T;
}

/** The text of an MCP tool result (all text parts); also used for error results. */
export function toolText(res: unknown): string {
  return ((res as ToolResult).content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

/** The first image of an MCP tool result as PNG bytes. */
export function toolImage(res: unknown): Buffer {
  const r = res as ToolResult;
  if (r.isError) throw new Error(`tool error: ${toolText(r)}`);
  const img = r.content?.find((c) => c.type === 'image');
  if (!img?.data) throw new Error(`no image in the tool result: ${toolText(r)}`);
  expect(img.mimeType).toBe('image/png');
  return Buffer.from(img.data, 'base64');
}

/** Calls an MCP tool and returns its parsed JSON (failing the test on a tool error). */
export async function callJson<T = any>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  return toolJson<T>(await client.callTool({ name, arguments: args }));
}

export function davAuthHeader(): string {
  return `Basic ${Buffer.from(`${WEBDAV.username}:${WEBDAV.password}`).toString('base64')}`;
}

export async function davGet(path: string): Promise<Response> {
  return fetch(`${WEBDAV.url}${path}`, { headers: { Authorization: davAuthHeader() } });
}

export async function newDevice(context: BrowserContext): Promise<Page> {
  return context.newPage();
}

// ---------------------------------------------------------------- PNG files

export interface PngChunk {
  type: string;
  data: Buffer;
}

/** The chunks of a PNG (or APNG) file, checking its signature. */
export function pngChunks(buf: Buffer): PngChunk[] {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const chunks: PngChunk[] = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, row by row. */
  data: Uint8Array;
}

/** Size and channels of a non-interlaced 8-bit grey, grey+alpha, RGB or RGBA PNG (the decodable ones). */
function pngHeader(chunks: PngChunk[]): { width: number; height: number; channels: number } {
  const ihdr = chunks.find((c) => c.type === 'IHDR')!.data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const [bitDepth, colorType, , , interlace] = ihdr.subarray(8, 13);
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (bitDepth !== 8 || !channels || interlace)
    throw new Error(
      `unsupported PNG: bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}`,
    );
  return { width, height, channels };
}

/** Decodes a non-interlaced 8-bit grey, RGB or RGBA PNG (the default image of an APNG). */
export function decodePng(buf: Buffer): RgbaImage {
  const chunks = pngChunks(buf);
  const { width, height, channels } = pngHeader(chunks);
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  return { width, height, data: unfilterToRgba(raw, width, height, channels) };
}

/** Reverses the PNG row filters of `width`×`height` pixels of `channels` bytes and expands them to RGBA. */
function unfilterToRgba(raw: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = (line[i] + pred) & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      const grey = channels <= 2;
      out[o] = cur[s];
      out[o + 1] = grey ? cur[s] : cur[s + 1];
      out[o + 2] = grey ? cur[s] : cur[s + 2];
      out[o + 3] = channels === 4 ? cur[s + 3] : channels === 2 ? cur[s + 1] : 255;
    }
    prev = cur;
  }
  return out;
}

/** One frame of an animated PNG, as a viewer shows it. */
export interface ApngFrame extends RgbaImage {
  /** The rectangle this frame redraws (its fcTL chunk); the rest is kept from the frames before. */
  region: Rect;
}

/**
 * Decodes every frame of an APNG: each frame's rectangle (fcTL, then IDAT or fdAT data) is drawn
 * onto the canvas with its blend operation (SOURCE or OVER), the full picture is taken, and the
 * rectangle is disposed of (NONE, BACKGROUND or PREVIOUS) before the next frame. Checks the shared
 * sequence numbers of the fcTL and fdAT chunks. `frameCount` and `plays` come from the acTL chunk.
 */
export function decodeApng(buf: Buffer): { frameCount: number; plays: number; frames: ApngFrame[] } {
  const chunks = pngChunks(buf);
  const { width, height, channels } = pngHeader(chunks);
  const actl = chunks.find((c) => c.type === 'acTL');
  if (!actl) throw new Error('not an animated PNG: no acTL chunk');
  // each frame's control chunk and data (IDAT belongs to the first frame when an fcTL precedes it)
  const parts: { fctl: Buffer; data: Buffer[] }[] = [];
  let seq = 0;
  for (const c of chunks) {
    if (c.type === 'fcTL' || c.type === 'fdAT')
      expect(c.data.readUInt32BE(0), `sequence number of an ${c.type} chunk`).toBe(seq++);
    if (c.type === 'fcTL') parts.push({ fctl: c.data, data: [] });
    else if (c.type === 'IDAT' && parts.length) parts[parts.length - 1].data.push(c.data);
    else if (c.type === 'fdAT') parts[parts.length - 1].data.push(c.data.subarray(4));
  }
  const canvas = new Uint8Array(width * height * 4);
  const frames = parts.map(({ fctl, data }, k): ApngFrame => {
    const region = {
      w: fctl.readUInt32BE(4),
      h: fctl.readUInt32BE(8),
      x: fctl.readUInt32BE(12),
      y: fctl.readUInt32BE(16),
    };
    const { x, y, w, h } = region;
    expect(x + w <= width && y + h <= height, `frame ${k + 1} lies inside the image`).toBe(true);
    // dispose_op PREVIOUS on the first frame means BACKGROUND
    const dispose = k === 0 && fctl[24] === 2 ? 1 : fctl[24];
    const blendOver = fctl[25] === 1;
    const pixels = unfilterToRgba(inflateSync(Buffer.concat(data)), w, h, channels);
    const before = dispose === 2 ? canvas.slice() : null;
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const s = (j * w + i) * 4;
        const o = ((y + j) * width + x + i) * 4;
        if (!blendOver) {
          canvas.set(pixels.subarray(s, s + 4), o);
          continue;
        }
        const a = pixels[s + 3] / 255;
        const b = (canvas[o + 3] / 255) * (1 - a);
        const alpha = a + b;
        for (let ch = 0; ch < 3; ch++)
          canvas[o + ch] = alpha ? Math.round((pixels[s + ch] * a + canvas[o + ch] * b) / alpha) : 0;
        canvas[o + 3] = Math.round(alpha * 255);
      }
    const frame = { width, height, data: canvas.slice(), region };
    if (dispose === 1)
      for (let j = 0; j < h; j++) canvas.fill(0, ((y + j) * width + x) * 4, ((y + j) * width + x + w) * 4);
    else if (before) canvas.set(before);
    return frame;
  });
  return { frameCount: actl.data.readUInt32BE(0), plays: actl.data.readUInt32BE(4), frames };
}

/** Decodes a `data:image/png;base64,…` URL. */
export function decodePngDataUrl(url: string): RgbaImage {
  expect(url.startsWith('data:image/png;base64,')).toBe(true);
  return decodePng(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
}

/** A rectangle of an image, in pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A rectangle given as fractions of the image size (0..1), e.g. the central tenth or the top rows. */
export function region(img: RgbaImage, fx: number, fy: number, fw: number, fh: number): Rect {
  const x = Math.floor(fx * img.width);
  const y = Math.floor(fy * img.height);
  return {
    x,
    y,
    w: Math.max(1, Math.min(img.width - x, Math.round(fw * img.width))),
    h: Math.max(1, Math.min(img.height - y, Math.round(fh * img.height))),
  };
}

function* pixels(img: RgbaImage, r: Rect = { x: 0, y: 0, w: img.width, h: img.height }) {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) yield (y * img.width + x) * 4;
}

export interface ImageStats {
  /** Mean colour (0..255). */
  rgb: [number, number, number];
  /** Luminance mean and standard deviation (0..255). */
  mean: number;
  std: number;
  /** Share of pixels with a luminance below 16. */
  dark: number;
  /** Distinct colours (5 bits per channel). */
  colors: number;
}

/** Colour statistics of an image or of a rectangle of it. */
export function imageStats(img: RgbaImage, rect?: Rect): ImageStats {
  let sum = 0;
  let sum2 = 0;
  let dark = 0;
  let n = 0;
  const rgb: [number, number, number] = [0, 0, 0];
  const colors = new Set<number>();
  for (const i of pixels(img, rect)) {
    const r = img.data[i];
    const g = img.data[i + 1];
    const b = img.data[i + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    rgb[0] += r;
    rgb[1] += g;
    rgb[2] += b;
    sum += l;
    sum2 += l * l;
    if (l < 16) dark++;
    colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
    n++;
  }
  const mean = sum / n;
  return {
    rgb: rgb.map((c) => c / n) as [number, number, number],
    mean,
    std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)),
    dark: dark / n,
    colors: colors.size,
  };
}

/**
 * Share of pixels (0..1), of the whole image or of a rectangle, whose colour differs by more than
 * `threshold` (sum of the RGB differences) between two images of the same size.
 */
export function changedFraction(a: RgbaImage, b: RgbaImage, rect?: Rect, threshold = 30): number {
  expect([b.width, b.height]).toEqual([a.width, a.height]);
  let changed = 0;
  let n = 0;
  for (const i of pixels(a, rect)) {
    const d =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (d > threshold) changed++;
    n++;
  }
  return changed / n;
}

/** A copy of a rectangle of an image, e.g. one cell of a contact sheet. */
export function crop(img: RgbaImage, r: Rect): RgbaImage {
  const inside = r.x >= 0 && r.y >= 0 && r.x + r.w <= img.width && r.y + r.h <= img.height;
  expect(inside, `${r.w}×${r.h} at (${r.x}, ${r.y}) lies inside the ${img.width}×${img.height} image`).toBe(
    true,
  );
  const data = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const from = ((r.y + y) * img.width + r.x) * 4;
    data.set(img.data.subarray(from, from + r.w * 4), y * r.w * 4);
  }
  return { width: r.w, height: r.h, data };
}

// ---------------------------------------------------------------- rendering in the editor

/**
 * Waits until the viewport shows every change made so far: the editor marks its canvas
 * `data-view="drawn"` once the GPU has drawn a frame with all of them (software WebGL can take
 * seconds for one, compiling shaders, while the page keeps showing the frame before), and the
 * browser has presented it (two more animation frames). A picture taken right after a panel shows
 * a change can otherwise show the frame before it.
 */
export async function viewportDrawn(page: Page): Promise<void> {
  const canvas = page.getByTestId('viewport').locator('canvas[data-view]');
  await expect(canvas).toHaveAttribute('data-view', 'drawn', { timeout: 60_000 });
  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}

/**
 * A screenshot of the whole 3D viewport, overlays included, once it shows every change
 * ({@link viewportDrawn}).
 */
export async function viewportShot(page: Page): Promise<RgbaImage> {
  await viewportDrawn(page);
  return decodePng(await page.getByTestId('viewport').screenshot());
}

/**
 * A screenshot of the middle of the 3D viewport, `size` pixels square: what the viewport draws
 * around the world origin in the default view, away from its overlays (header text, statistics,
 * navigation gizmo, the Adjust Last Operation panel), once it shows every change
 * ({@link viewportDrawn}).
 */
export async function viewportCentre(page: Page, size = 160): Promise<RgbaImage> {
  await viewportDrawn(page);
  const box = (await page.getByTestId('viewport').boundingBox())!;
  const clip = {
    x: Math.round(box.x + box.width / 2 - size / 2),
    y: Math.round(box.y + box.height / 2 - size / 2),
    width: size,
    height: size,
  };
  return decodePng(await page.screenshot({ clip }));
}

/** Sets the output resolution scale (Output tab, "%"), e.g. 5 % of 1920×1080 = 96×54 pixels. */
export async function setOutputPercentage(page: Page, percent: number): Promise<void> {
  await page.getByTestId('prop-tab-output').click();
  const field = page
    .locator('.prop-row')
    .filter({ has: page.getByText('%', { exact: true }) })
    .locator('.numfield');
  await field.click();
  await field.locator('input').fill(String(percent));
  await field.locator('input').press('Enter');
  await expect(field).toHaveText(`${percent}%`);
}

/**
 * Renders the scene camera like a user (F12 over the viewport, the Render window), waits for the
 * finished image, closes the window and returns the image.
 */
export async function renderStill(page: Page, timeout = 60_000): Promise<RgbaImage> {
  await page.getByTestId('viewport').hover();
  await page.keyboard.press('F12');
  const image = page.getByTestId('render-image');
  await expect(image).toBeVisible({ timeout });
  const src = (await image.getAttribute('src')) ?? '';
  await page.locator('.modal .close').click();
  await expect(page.getByTestId('render-dialog')).toHaveCount(0);
  return decodePngDataUrl(src);
}
