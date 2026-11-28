import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rewriteRequestUrl } from '../../src/request-base';
import { registerStatic } from '../../src/static';
import { makeTempDir } from '../helpers/app';

/*
 * The server's answers at the build's folders (static.ts, docs/subpath.md): fastify-static sends
 * the build's files only, so that a folder of the build, without its slash (`/icons`, `/assets`)
 * as with it, gets what every other path that names no built file gets: the editor's page for a
 * GET or HEAD, with the request's `<base href>`, and 404 under `/assets/`. Never the empty 200
 * fastify-static answered a folder without its slash with (it calls reply.callNotFound() for a
 * folder without returning it, and Fastify logs "Reply was already sent").
 */

const INDEX_HTML = '<!doctype html><html><head><title>3D Editor</title></head><body></body></html>';
const DESK_HTML = "<!doctype html><html><head><title>3D director's desk</title></head></html>";
const ICON = '<svg xmlns="http://www.w3.org/2000/svg"/>';
const SCRIPT = 'console.log(1)';
const PAGE = 'text/html; charset=utf-8';

let dir: string;
/** A build: the two pages, the service worker, a file in `icons/` and one in `assets/`. */
let build: string;
/** The same build through links, as e2e/tests/desk-partition.spec.ts serves it, and a link loop. */
let linked: string;

beforeAll(async () => {
  dir = await makeTempDir('3d-editor-static-');
  build = path.join(dir, 'build');
  await mkdir(path.join(build, 'icons'), { recursive: true });
  await mkdir(path.join(build, 'assets'));
  await writeFile(path.join(build, 'index.html'), INDEX_HTML);
  await writeFile(path.join(build, 'desk.html'), DESK_HTML);
  await writeFile(path.join(build, 'sw.js'), SCRIPT);
  await writeFile(path.join(build, 'icons', 'icon.svg'), ICON);
  await writeFile(path.join(build, 'assets', 'app-1a2b3c.js'), SCRIPT);
  linked = path.join(dir, 'linked');
  await mkdir(linked);
  for (const entry of ['index.html', 'desk.html', 'sw.js', 'icons', 'assets'])
    await symlink(path.join(build, entry), path.join(linked, entry));
  await symlink('.', path.join(linked, 'loop'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Served {
  app: FastifyInstance;
  /** The messages the server logged at warn and above. */
  warnings: string[];
}

/** The static routes of `publicDir` behind the server's URL rewrite, with BASE_PATH `basePath`. */
async function serve(publicDir: string, basePath = ''): Promise<Served> {
  const warnings: string[] = [];
  const app = Fastify({
    logger: {
      level: 'warn',
      stream: { write: (line: string) => void warnings.push(String(JSON.parse(line).msg)) },
    },
    rewriteUrl: (req) => rewriteRequestUrl(req, basePath),
  });
  expect(await registerStatic(app, publicDir)).toBe(true);
  await app.ready();
  return { app, warnings };
}

/** Asks for `url` with GET and HEAD, as a page the browser opens and as a fetch (any type). */
/** What an answer was: its status, type, length (Content-Length) and body. */
interface Answer {
  status: number;
  type: unknown;
  length: number;
  body: string;
}

async function eachRead({ app }: Served, url: string, check: (got: Answer, what: string) => void) {
  for (const method of ['GET', 'HEAD'] as const)
    for (const accept of ['text/html,application/xhtml+xml,*/*;q=0.8', '*/*']) {
      const res = await app.inject({ method, url, headers: { accept } });
      const got = {
        status: res.statusCode,
        type: res.headers['content-type'],
        length: Number(res.headers['content-length']),
        body: res.body,
      };
      check(got, `${method} ${url} (${accept})`);
    }
}

/** The editor's page with `<base href="${base}">` (for a HEAD, its type and length). */
function expectPage(base: string) {
  return (got: Answer, what: string) => {
    expect(got.status, what).toBe(200);
    expect(got.type, what).toBe(PAGE);
    expect(got.length, what).toBeGreaterThan(0);
    if (!what.startsWith('GET')) return;
    expect(got.body, what).toContain(`<base href="${base}" />`);
    expect(got.body, what).toContain('<title>3D Editor</title>');
  };
}

/** 404 with the path as the client sent it. */
function expectNotFound(pathname: string) {
  return (got: Answer, what: string) => {
    expect(got.status, what).toBe(404);
    if (what.startsWith('GET'))
      expect(JSON.parse(got.body), what).toEqual({ error: `not found: ${pathname}` });
  };
}

function expectNoLateReply({ warnings }: Served) {
  expect(warnings.filter((m) => m.includes('Reply was already sent'))).toEqual([]);
}

describe('the server at the folders of the build (registerStatic)', () => {
  it("answers a folder of the build without its slash as with it, as every path that names no built file: the editor's page for a GET or HEAD, 404 under /assets/", async () => {
    const s = await serve(build);
    try {
      for (const url of ['/icons', '/icons/', '/assets', '/icons?x=1', '/x/y'])
        await eachRead(s, url, expectPage('/'));
      await eachRead(s, '/assets/', expectNotFound('/assets/'));
      expectNoLateReply(s);
    } finally {
      await s.app.close();
    }
  });

  it('answers them the same under BASE_PATH, with its base', async () => {
    const s = await serve(build, '/3d');
    try {
      for (const url of ['/3d/icons', '/3d/icons/', '/3d/assets', '/3d/x/y'])
        await eachRead(s, url, expectPage('/3d/'));
      await eachRead(s, '/3d/assets/', expectNotFound('/3d/assets/'));
      expectNoLateReply(s);
    } finally {
      await s.app.close();
    }
  });

  it("sends the build's files from the file server, with their types and cache policy, also through linked folders", async () => {
    for (const [publicDir, base] of [
      [build, ''],
      [build, '/3d'],
      [linked, ''],
    ] as const) {
      const s = await serve(publicDir, base);
      try {
        const icon = await s.app.inject({ method: 'GET', url: `${base}/icons/icon.svg` });
        expect(icon.statusCode, `${publicDir} ${base}`).toBe(200);
        expect(icon.headers['content-type'], `${publicDir} ${base}`).toMatch(/^image\/svg\+xml/);
        expect(icon.body).toBe(ICON);
        const script = await s.app.inject({ method: 'GET', url: `${base}/assets/app-1a2b3c.js` });
        expect(script.statusCode, `${publicDir} ${base}`).toBe(200);
        expect(script.headers['cache-control']).toBe('public, max-age=31536000, immutable');
        expect(script.body).toBe(SCRIPT);
        const sw = await s.app.inject({ method: 'HEAD', url: `${base}/sw.js` });
        expect(sw.statusCode, `${publicDir} ${base}`).toBe(200);
        expect(sw.headers['cache-control']).toBe('no-cache');
        expect(sw.headers['content-type']).toMatch(/javascript/);
        expectNoLateReply(s);
      } finally {
        await s.app.close();
      }
    }
  });

  it('answers the folders of a build served through links as those of the build, and a link loop ends', async () => {
    const s = await serve(linked);
    try {
      for (const url of ['/icons', '/icons/', '/assets', '/loop', '/loop/'])
        await eachRead(s, url, expectPage('/'));
      await eachRead(s, '/assets/', expectNotFound('/assets/'));
      expectNoLateReply(s);
    } finally {
      await s.app.close();
    }
  });
});
