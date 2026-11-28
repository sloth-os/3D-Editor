import http, { type IncomingHttpHeaders } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../helpers/app';
import { mkcolPath, startWebDAV, type TestWebDAV } from '../helpers/webdav';

/*
 * WebDAV locks through the proxy under a base path (dav/if-header.ts, docs/subpath.md): the
 * resource tags of an If header name resources in the editor's namespace (`/3d/dav/x.txt?token=…`)
 * and are mapped into WEBDAV_URL's, as a Destination is, so that a WebDAV server that holds locks
 * by their tokens applies the lists to its own resources and never sees the editor's token. The
 * fixture (`locks`) holds them more strictly than Apache httpd and Sabre/DAV on purpose: a lock's
 * token counts only in a list that applies to the path, so that a tag that did not arrive mapped
 * fails the write. State tokens of any form (webdav-server's `urn:uuid:…`, the bare numbers
 * golang.org/x/net/webdav gives out), entity tags, `Not`, no-tag lists and Lock-Token reach it as
 * sent. A tag outside WEBDAV_URL is refused as a Destination outside is (502) and named; an If
 * header that does not parse, or that a WebDAV server could read with other tags, lists or
 * conditions, with 400; neither reaches the WebDAV server. The answers name resources in the
 * editor's namespace: the lockroot of a LOCK and the href of a 423's lock-token-submitted.
 */

const TOKEN = 'dav-locks-s3cret';
const OUTSIDE = { error: 'Destination must be inside /3d/dav/' };
/** The answer to an If header whose resource tag `tag` (as sent, its token redacted) is outside. */
const ifOutside = (tag: string) => ({ error: `If header resource tag <${tag}> must be inside /3d/dav/` });
const INVALID = { error: 'invalid If header' };
const LOCK_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope>' +
  '<d:locktype><d:write/></d:locktype><d:owner>dav-locks.test</d:owner></d:lockinfo>';
/** The LOCK body macOS Finder sends. */
const FINDER_LOCK_BODY =
  '<?xml version="1.0" encoding="utf-8"?>\n<D:lockinfo xmlns:D="DAV:">\n<D:lockscope><D:exclusive/></D:lockscope>\n' +
  '<D:locktype><D:write/></D:locktype>\n<D:owner>\n<D:href>http://www.apple.com/webdav_fs/</D:href>\n</D:owner>\n</D:lockinfo>\n';
const PROPPATCH_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propertyupdate xmlns:d="DAV:" xmlns:z="urn:dav-locks-test">' +
  '<d:set><d:prop><z:colour>blue</z:colour></d:prop></d:set></d:propertyupdate>';

let dav: TestWebDAV;
let server: TestServer;
/** Every request the WebDAV server got from the editor server during the current test. */
const upstream: { method: string; url: string; headers: IncomingHttpHeaders }[] = [];
/** And during all of them. */
const everything: typeof upstream = [];

beforeAll(async () => {
  dav = await startWebDAV({
    locks: true,
    onRequest: ({ method, url, headers }) => {
      // the proxy's own requests (this test reads the WebDAV server directly too)
      if (headers['user-agent'] !== '3d-editor-server (webdav proxy)') return;
      upstream.push({ method, url, headers });
      everything.push({ method, url, headers });
    },
  });
  await mkcolPath(dav, '/guarded');
  server = await startServer({
    WEBDAV_URL: `${dav.origin}/guarded`,
    WEBDAV_USERNAME: dav.username,
    WEBDAV_PASSWORD: dav.password,
    SYNC_PERSISTENCE: 'memory',
    BASE_PATH: '/3d',
    AUTH_TOKEN: TOKEN,
  });
});

// each test reads the requests it made itself
beforeEach(() => {
  upstream.length = 0;
});

afterAll(async () => {
  await server?.close();
  await server?.cleanup();
  await dav?.stop();
});

/**
 * A request with this exact target to the editor server (`port`, else the one all tests share); a
 * header given as an array is sent as that many lines.
 */
function request(
  target: string,
  init: { method?: string; headers?: Record<string, string | string[]>; body?: string; port?: number } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: init.port ?? server.port,
        method: init.method ?? 'GET',
        path: target,
        headers: init.headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

/** `/3d/dav/<name>?token=…`: a URL of the editor's WebDAV proxy as a client with the token reads it. */
const editorUrl = (name: string) => `/3d/dav/${name}?token=${TOKEN}`;

/** Locks a file through the proxy and gives the lock's token (`urn:uuid:…`) and the answer's body. */
async function lock(name: string): Promise<{ token: string; body: string }> {
  const res = await request(editorUrl(name), {
    method: 'LOCK',
    headers: { 'content-type': 'application/xml', timeout: 'Second-600' },
    body: LOCK_BODY,
  });
  expect(res.status, res.body).toBe(200);
  const token = String(res.headers['lock-token']).replace(/^<|>$/g, '');
  expect(token).toMatch(/^urn:uuid:[0-9a-f-]+$/);
  return { token, body: res.body };
}

/** A file on the WebDAV server, or null. */
async function upstreamFile(p: string): Promise<string | null> {
  const res = await fetch(`${dav.origin}${p}`, { headers: { authorization: dav.authorization } });
  return res.status === 200 ? res.text() : null;
}

describe('WebDAV locks through the proxy under a base path', () => {
  it('maps If resource tags into WEBDAV_URL: PUT, PROPPATCH and DELETE of a locked file succeed with tagged lists', async () => {
    let res = await request(editorUrl('locked.txt'), { method: 'PUT', body: 'one' });
    expect(res.status).toBe(201);
    const { token, body } = await lock('locked.txt');
    // the lockroot is the file in the editor's namespace; the lock token is no URL of WEBDAV_URL
    expect(body).toContain('<D:lockroot><D:href>/3d/dav/locked.txt</D:href></D:lockroot>');
    expect(body).toContain(`<D:locktoken><D:href>${token}</D:href></D:locktoken>`);
    expect(body).not.toContain(dav.origin);

    // the lock holds: a write without the token, or with it in a list tagged with another file, is
    // refused, and the 423 names the lock's root in the editor's namespace
    const refused: Record<string, string>[] = [{}, { if: `</3d/dav/other.txt> (<${token}>)` }];
    for (const headers of refused) {
      res = await request(editorUrl('locked.txt'), { method: 'PUT', headers, body: 'refused' });
      expect(res.status, JSON.stringify(headers)).toBe(423);
      expect(res.body).toContain('<d:href>/3d/dav/locked.txt</d:href>');
      expect(res.body).not.toContain('/guarded/');
    }
    expect(await upstreamFile('/guarded/locked.txt')).toBe('one');

    // the tag of the file as a client may spell it: the lockroot given out, the request URL with
    // its token, absolute on this server or on the host a proxy gives the editor, without the base
    const own = `${dav.origin}/guarded/locked.txt`;
    upstream.length = 0;
    const tags = [
      '/3d/dav/locked.txt',
      `http://127.0.0.1:${server.port}${editorUrl('locked.txt')}`,
      `https://editor.example/3d/dav/locked.txt?token=${TOKEN}`,
      `/dav/locked.txt?%74oken=${TOKEN}`,
      '/3d/dav/locked%2Etxt',
    ];
    for (const [i, tag] of tags.entries()) {
      res = await request(editorUrl('locked.txt'), {
        method: 'PUT',
        headers: { if: `<${tag}> (<${token}>)` },
        body: `write ${i}`,
      });
      expect(res.status, tag).toBeLessThan(300);
      expect(await upstreamFile('/guarded/locked.txt'), tag).toBe(`write ${i}`);
    }
    // the WebDAV server got each tag as its own URL of the file, without the token
    expect(upstream.map((r) => r.headers.if)).toEqual(tags.map(() => `<${own}> (<${token}>)`));

    upstream.length = 0;
    res = await request(editorUrl('locked.txt'), {
      method: 'PROPPATCH',
      headers: { 'content-type': 'application/xml', if: `<${editorUrl('locked.txt')}> (<${token}>)` },
      body: PROPPATCH_BODY,
    });
    expect(res.status, res.body).toBe(207);
    expect(res.body).toContain('/3d/dav/locked.txt');
    expect(res.body).toMatch(/HTTP\/1\.1 200/);
    expect(upstream.map((r) => [r.method, r.headers.if])).toEqual([['PROPPATCH', `<${own}> (<${token}>)`]]);

    upstream.length = 0;
    res = await request(editorUrl('locked.txt'), {
      method: 'DELETE',
      headers: { if: `<http://127.0.0.1:${server.port}/3d/dav/locked.txt> (<${token}>)` },
    });
    expect(res.status, res.body).toBeLessThan(300);
    expect(await upstreamFile('/guarded/locked.txt')).toBeNull();
    expect(upstream.map((r) => [r.method, r.headers.if])).toEqual([['DELETE', `<${own}> (<${token}>)`]]);
  });

  it('passes no-tag lists, state tokens, entity tags, Not and Lock-Token on as sent', async () => {
    let res = await request(editorUrl('kept.txt'), { method: 'PUT', body: 'one' });
    expect(res.status).toBe(201);
    const { token } = await lock('kept.txt');
    const own = `${dav.origin}/guarded/kept.txt`;
    const tag = `http://127.0.0.1:${server.port}${editorUrl('kept.txt')}`;
    // what the client sends, what the WebDAV server gets, and whether the write goes through there
    const cases: [string, string, boolean][] = [
      // a list without a tag applies to the request's own resource
      [`(<${token}>)`, `(<${token}>)`, true],
      [`(<${token}>)\t(Not <DAV:no-lock>)`, `(<${token}>)\t(Not <DAV:no-lock>)`, true],
      // the entity tag is no ETag of the file: a list with it fails, with Not before it holds
      [`<${tag}> (<${token}> ["x"])`, `<${own}> (<${token}> ["x"])`, false],
      [`<${tag}> (<${token}>\t[W/"x"])`, `<${own}> (<${token}>\t[W/"x"])`, false],
      [`<${tag}> (Not ["x"]) (<${token}>)`, `<${own}> (Not ["x"]) (<${token}>)`, true],
      // two lists for the file: the first fails, the second holds; a tab after the tag
      [
        `<${tag}> (<urn:uuid:00000000-0000-0000-0000-000000000000>)(<${token}>)`,
        `<${own}> (<urn:uuid:00000000-0000-0000-0000-000000000000>)(<${token}>)`,
        true,
      ],
      [`<${tag}>\t(<${token}>)`, `<${own}>\t(<${token}>)`, true],
    ];
    let content = 'one';
    for (const [sent, got, written] of cases) {
      upstream.length = 0;
      res = await request(editorUrl('kept.txt'), { method: 'PUT', headers: { if: sent }, body: sent });
      if (written) expect(res.status, sent).toBeLessThan(300);
      else expect(res.status, sent).toBe(412);
      expect(
        upstream.map((r) => r.headers.if),
        sent,
      ).toEqual([got]);
      if (written) content = sent;
      expect(await upstreamFile('/guarded/kept.txt'), sent).toBe(content);
    }

    upstream.length = 0;
    res = await request(editorUrl('kept.txt'), { method: 'UNLOCK', headers: { 'lock-token': `<${token}>` } });
    expect(res.status).toBe(204);
    expect(upstream.map((r) => [r.method, r.headers['lock-token']])).toEqual([['UNLOCK', `<${token}>`]]);
    // unlocked: a write needs no token now
    res = await request(editorUrl('kept.txt'), { method: 'PUT', body: 'unlocked' });
    expect(res.status).toBeLessThan(300);
    expect(await upstreamFile('/guarded/kept.txt')).toBe('unlocked');
  });

  it('refuses an If tag outside WEBDAV_URL (502, as a Destination outside, named) and an If header that does not parse or that a server could read otherwise (400)', async () => {
    let res = await request(editorUrl('refused.txt'), { method: 'PUT', body: 'one' });
    expect(res.status).toBe(201);
    const { token } = await lock('refused.txt');
    upstream.length = 0;
    // a Destination outside, for comparison
    res = await request(editorUrl('refused.txt'), {
      method: 'COPY',
      headers: { destination: '/3d/api/projects' },
    });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body)).toEqual(OUTSIDE);
    // the header, and the tag the answer names (the first outside, its token redacted)
    for (const [header, named] of [
      [`</3d/api/projects> (<${token}>)`, '/3d/api/projects'],
      [`</3d/dav/..%2f..%2foutside.txt> (<${token}>)`, '/3d/dav/..%2f..%2foutside.txt'],
      [`</3d/dav/..;/outside.txt> (<${token}>)`, '/3d/dav/..;/outside.txt'],
      [
        `<http://editor.example/other/dav/refused.txt> (<${token}>)`,
        'http://editor.example/other/dav/refused.txt',
      ],
      [`<ftp://editor.example/3d/dav/refused.txt> (<${token}>)`, 'ftp://editor.example/3d/dav/refused.txt'],
      [`<${dav.origin}/guarded/refused.txt> (<${token}>)`, `${dav.origin}/guarded/refused.txt`],
      [`</3d/api/projects?token=${TOKEN}&a=1> (<${token}>)`, '/3d/api/projects?token=[REDACTED]&a=1'],
      // one tag outside among tags inside, the first of two outside
      [`</3d/dav/refused.txt> (<${token}>) </3d/sync/x> (<${token}>)`, '/3d/sync/x'],
      [`</3d/sync/one> (<${token}>) </3d/sync/two> (<${token}>)`, '/3d/sync/one'],
    ]) {
      for (const method of ['PUT', 'DELETE', 'PROPPATCH']) {
        const body = method === 'DELETE' ? undefined : 'refused';
        res = await request(editorUrl('refused.txt'), { method, headers: { if: header }, body });
        expect(res.status, `${method} ${header}`).toBe(502);
        expect(JSON.parse(res.body), header).toEqual(ifOutside(named));
        expect(res.body).not.toContain(TOKEN);
      }
    }
    for (const header of [
      '',
      '(',
      `(<${token}>`,
      `<${editorUrl('refused.txt')}>`,
      `(<${token}>) </3d/dav/refused.txt> (<${token}>)`,
      `</3d/dav/refused.txt> ()`,
      `</3d/dav/refused.txt> (${token})`,
      `</3d/dav/refused.txt> (["a"b"])`,
      `</3d/dav/refused.txt> (<${token}>) ,`,
      // a tag outside hidden where Sabre/DAV, mod_dav, golang.org/x/net/webdav or webdav-server
      // would read one: in an entity tag, after a state token in a list of two, after two spaces
      `</3d/dav/refused.txt> (<${token}>) (["x)</outside.txt>(y"])`,
      `</3d/dav/refused.txt> (Not <urn:x>) (["x] </outside.txt> ([\\"e\\"]) "])`,
      `</3d/dav/refused.txt> (["x]) </outside.txt> ([\\"e\\"]) ([\\""])`,
      `</3d/dav/refused.txt> (<${token}> <http://h/outside.txt#>) </3d/dav/refused.txt> (["e"])`,
      `</3d/dav/refused.txt> (<urn:b> <urn:a/../../outside.txt#>) </3d/dav/refused.txt> (["e"])`,
      `</3d/dav/refused.txt>  (Not <urn:a/../../outside.txt#>) </3d/dav/refused.txt> (["e"])`,
      // the forms other servers read otherwise: `not`, `Not` before two conditions, no space after a tag
      `(not <${token}>)`,
      `(Not <urn:x> <${token}>)`,
      `</3d/dav/refused.txt>(<${token}>)`,
    ]) {
      res = await request(editorUrl('refused.txt'), {
        method: 'PUT',
        headers: { if: header },
        body: 'refused',
      });
      expect(res.status, JSON.stringify(header)).toBe(400);
      expect(JSON.parse(res.body), header).toEqual(INVALID);
    }
    // two If lines, which Node joins with `, `: no If header the grammar allows
    res = await request(editorUrl('refused.txt'), {
      method: 'PUT',
      headers: { if: [`</3d/dav/refused.txt> (<${token}>)`, `</3d/dav/refused.txt> (<${token}>)`] },
      body: 'refused',
    });
    expect(res.status).toBe(400);
    expect(upstream).toEqual([]);
    expect(await upstreamFile('/guarded/refused.txt')).toBe('one');
  });

  it('never handed the WebDAV server the editor token', () => {
    for (const r of everything) expect(JSON.stringify(r), `${r.method} ${r.url}`).not.toContain(TOKEN);
    // the requests of the tests above, all of them
    expect(everything.length).toBeGreaterThan(20);
  });
});

describe('WebDAV locks whose tokens are bare numbers, as golang.org/x/net/webdav (rclone) gives them out', () => {
  let numeric: TestWebDAV;
  let editor: TestServer;
  /** Every request the WebDAV server got from the editor server. */
  const got: { method: string; url: string; headers: IncomingHttpHeaders }[] = [];

  beforeAll(async () => {
    numeric = await startWebDAV({
      locks: true,
      decimalLockTokens: true,
      onRequest: ({ method, url, headers }) => {
        if (headers['user-agent'] === '3d-editor-server (webdav proxy)') got.push({ method, url, headers });
      },
    });
    await mkcolPath(numeric, '/guarded');
    editor = await startServer({
      WEBDAV_URL: `${numeric.origin}/guarded`,
      WEBDAV_USERNAME: numeric.username,
      WEBDAV_PASSWORD: numeric.password,
      SYNC_PERSISTENCE: 'memory',
      BASE_PATH: '/3d',
      AUTH_TOKEN: TOKEN,
    });
  });

  afterAll(async () => {
    await editor?.close();
    await editor?.cleanup();
    await numeric?.stop();
  });

  it('passes them on as sent in the forms Finder and Windows send: (<token>) with PUT, PROPPATCH and a LOCK refresh, a tagged list, Lock-Token with UNLOCK', async () => {
    const port = editor.port;
    const url = editorUrl('n.txt');
    let res = await request(url, { method: 'PUT', body: 'one', port });
    expect(res.status).toBe(201);
    res = await request(url, {
      method: 'LOCK',
      port,
      headers: { 'content-type': 'text/xml; charset="utf-8"', depth: '0', timeout: 'Second-600' },
      body: FINDER_LOCK_BODY,
    });
    expect(res.status, res.body).toBe(200);
    const token = String(res.headers['lock-token']).replace(/^<|>$/g, '');
    expect(token).toMatch(/^\d+$/);
    expect(res.body).toContain(`<D:locktoken><D:href>${token}</D:href></D:locktoken>`);
    expect(res.body).toContain('<D:lockroot><D:href>/3d/dav/n.txt</D:href></D:lockroot>');
    // the lock holds: a write without its token is refused
    res = await request(url, { method: 'PUT', body: 'refused', port });
    expect(res.status).toBe(423);
    const stored = async () =>
      (
        await fetch(`${numeric.origin}/guarded/n.txt`, { headers: { authorization: numeric.authorization } })
      ).text();
    expect(await stored()).toBe('one');

    // the form Finder and Windows send, with a PUT, a PROPPATCH and a LOCK refresh
    const sent = `(<${token}>)`;
    got.length = 0;
    res = await request(url, { method: 'PUT', headers: { if: sent }, body: 'two', port });
    expect(res.status, res.body).toBeLessThan(300);
    expect(await stored()).toBe('two');
    res = await request(url, {
      method: 'PROPPATCH',
      port,
      headers: { 'content-type': 'application/xml', if: sent },
      body: PROPPATCH_BODY,
    });
    expect(res.status, res.body).toBe(207);
    res = await request(url, { method: 'LOCK', port, headers: { if: sent, timeout: 'Second-600' } });
    expect(res.status, res.body).toBe(200);
    expect(res.headers['lock-token']).toBeUndefined();
    expect(res.body).toContain(`<D:locktoken><D:href>${token}</D:href></D:locktoken>`);
    expect(got.map((r) => [r.method, r.headers.if])).toEqual([
      ['PUT', sent],
      ['PROPPATCH', sent],
      ['LOCK', sent],
    ]);

    // a tagged list, as davfs2 sends one: the tag arrives mapped, the token as sent
    got.length = 0;
    res = await request(url, {
      method: 'PUT',
      port,
      headers: { if: `<http://127.0.0.1:${port}${url}> (<${token}>)` },
      body: 'three',
    });
    expect(res.status, res.body).toBeLessThan(300);
    expect(await stored()).toBe('three');
    expect(got.map((r) => r.headers.if)).toEqual([`<${numeric.origin}/guarded/n.txt> (<${token}>)`]);

    // UNLOCK with its Lock-Token, then a write needs no token
    got.length = 0;
    res = await request(url, { method: 'UNLOCK', port, headers: { 'lock-token': `<${token}>` } });
    expect(res.status).toBe(204);
    expect(got.map((r) => [r.method, r.headers['lock-token']])).toEqual([['UNLOCK', `<${token}>`]]);
    res = await request(url, { method: 'PUT', body: 'unlocked', port });
    expect(res.status).toBeLessThan(300);
    expect(await stored()).toBe('unlocked');
    for (const r of got) expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});
