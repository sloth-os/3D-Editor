import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTempDir, startServer, type TestServer } from '../helpers/app';

/*
 * The server's headers of the embeddable desk (static.ts with desk-embed.ts): desk.html, also at
 * /desk, with COEP, CORP and CSP frame-ancestors from DESK_EMBED_COEP and DESK_EMBED_ORIGINS; the
 * built assets with COEP and CORP; the editor's own pages without them; never X-Frame-Options; and
 * /desk never answered with the editor's index.html.
 */

let publicDir: string;
const servers: TestServer[] = [];

async function serve(env: Record<string, string> = {}, dir = publicDir): Promise<TestServer> {
  const s = await startServer({ PUBLIC_DIR: dir, ...env });
  servers.push(s);
  return s;
}

beforeAll(async () => {
  publicDir = await makeTempDir('3d-editor-desk-public-');
  await mkdir(path.join(publicDir, 'assets'));
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>3D Editor</title>');
  await writeFile(path.join(publicDir, 'desk.html'), "<!doctype html><title>3D director's desk</title>");
  await writeFile(path.join(publicDir, 'assets', 'desk-1a2b3c.js'), 'console.log(1)');
  await writeFile(path.join(publicDir, 'assets', 'stage.worker-1a2b3c.js'), 'console.log(2)');
  await writeFile(path.join(publicDir, 'sw.js'), 'self.addEventListener("fetch", () => {})');
});

afterAll(async () => {
  for (const s of servers) {
    await s.close();
    await s.cleanup();
  }
  await rm(publicDir, { recursive: true, force: true });
});

const get = (s: TestServer, p: string) => fetch(`${s.url}${p}`);

describe('the desk page', () => {
  it('is served with COEP, CORP and frame-ancestors, at /desk.html and /desk', async () => {
    const s = await serve();
    for (const p of ['/desk.html', '/desk', '/desk?scene=1', '/desk.html?x=y']) {
      const res = await get(s, p);
      expect(res.status, p).toBe(200);
      expect(await res.text()).toContain("director's desk");
      expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
      expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
      expect(res.headers.get('content-security-policy')).toBe('frame-ancestors *');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('x-frame-options')).toBeNull();
    }
  });

  it('gives the built assets COEP and CORP, and the editor none of the desk headers', async () => {
    const s = await serve();
    for (const p of ['/assets/desk-1a2b3c.js', '/assets/stage.worker-1a2b3c.js']) {
      const res = await get(s, p);
      expect(res.status).toBe(200);
      expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
      expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('content-security-policy')).toBeNull();
    }
    for (const p of ['/', '/index.html', '/projects/abc', '/sw.js']) {
      const res = await get(s, p);
      expect(res.status, p).toBe(200);
      expect(res.headers.get('cross-origin-embedder-policy'), p).toBeNull();
      expect(res.headers.get('content-security-policy'), p).toBeNull();
      expect(res.headers.get('x-frame-options'), p).toBeNull();
    }
  });

  it('follows DESK_EMBED_COEP and DESK_EMBED_ORIGINS', async () => {
    const s = await serve({
      DESK_EMBED_COEP: 'credentialless',
      DESK_EMBED_ORIGINS: 'https://rideo.example, https://*.example.org',
    });
    const res = await get(s, '/desk.html');
    expect(res.headers.get('cross-origin-embedder-policy')).toBe('credentialless');
    expect(res.headers.get('content-security-policy')).toBe(
      'frame-ancestors https://rideo.example https://*.example.org',
    );
    expect((await get(s, '/assets/desk-1a2b3c.js')).headers.get('cross-origin-embedder-policy')).toBe(
      'credentialless',
    );
    const off = await serve({ DESK_EMBED_COEP: 'off' });
    const page = await get(off, '/desk.html');
    expect(page.headers.get('cross-origin-embedder-policy')).toBeNull();
    expect(page.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(page.headers.get('content-security-policy')).toBe('frame-ancestors *');
  });

  it('is never the editor: /desk without a desk build is not found', async () => {
    const dir = await makeTempDir('3d-editor-nodesk-public-');
    try {
      await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>3D Editor</title>');
      const s = await serve({}, dir);
      expect((await get(s, '/desk')).status).toBe(404);
      expect((await get(s, '/desk.html')).status).toBe(404);
      expect((await get(s, '/elsewhere')).status).toBe(200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
