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

export async function mcpConnect(base: string): Promise<Client> {
  const client = new Client({ name: 'e2e-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return client;
}

/** Parses the JSON text content of an MCP tool result. */
export function toolJson<T = any>(res: unknown): T {
  const r = res as { content?: { type: string; text?: string }[]; isError?: boolean };
  if (r.isError) throw new Error(`tool error: ${r.content?.map((c) => c.text).join('\n')}`);
  const text = r.content?.find((c) => c.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as T;
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
