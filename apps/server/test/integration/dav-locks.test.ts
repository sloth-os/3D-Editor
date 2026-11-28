import http, { type IncomingHttpHeaders } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../helpers/app';
import { mkcolPath, startWebDAV, type TestWebDAV } from '../helpers/webdav';

/*
 * WebDAV locks through the proxy under a base path (dav/if-header.ts, docs/subpath.md): the
 * resource tags of an If header name resources in the editor's namespace (`/3d/dav/x.txt?token=…`)
 * and are mapped into WEBDAV_URL's, as a Destination is, so that a WebDAV server that holds locks
 * by their tokens (the fixture with `locks`, as Apache httpd and Sabre/DAV do) applies the lists
 * to its own resources and never sees the editor's token. State tokens, entity tags, `Not`, no-tag
 * lists and Lock-Token reach it as sent. A tag outside WEBDAV_URL is refused as a Destination
 * outside is (502), an If header that does not parse with 400, and neither reaches the WebDAV
 * server. The answers name resources in the editor's namespace: the lockroot of a LOCK and the
 * href of a 423's lock-token-submitted.
 */

const TOKEN = 'dav-locks-s3cret';
const OUTSIDE = { error: 'Destination must be inside /3d/dav/' };
const LOCK_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope>' +
  '<d:locktype><d:write/></d:locktype><d:owner>dav-locks.test</d:owner></d:lockinfo>';
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
 * A request with this exact target to the editor server; a header given as an array is sent as
 * that many lines.
 */
function request(
  target: string,
  init: { method?: string; headers?: Record<string, string | string[]>; body?: string } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
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
    // an entity tag that holds `)`, `<`, `>`, `(`, `[` and `]`, and the URL of a file in it
    const etag = '["x)</3d/dav/other.txt>(y]"]';
    // what the client sends, what the WebDAV server gets, and whether the write goes through there
    const cases: [string, string, boolean][] = [
      // a list without a tag applies to the request's own resource
      [`(<${token}>)`, `(<${token}>)`, true],
      [`(<${token}>)\t(Not <DAV:no-lock>)`, `(<${token}>)\t(Not <DAV:no-lock>)`, true],
      // the entity tag is no ETag of the file: the list holds with Not before it, fails without
      [`<${tag}> (<${token}> Not ${etag})`, `<${own}> (<${token}> Not ${etag})`, true],
      [`<${tag}> (<${token}> ${etag})`, `<${own}> (<${token}> ${etag})`, false],
      // two lists for the file: the first fails, the second holds
      [
        `<${tag}>(<urn:uuid:00000000-0000-0000-0000-000000000000>)(<${token}>)`,
        `<${own}>(<urn:uuid:00000000-0000-0000-0000-000000000000>)(<${token}>)`,
        true,
      ],
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

  it('refuses an If tag outside WEBDAV_URL (502, as a Destination outside) and an If header that does not parse (400)', async () => {
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
    for (const header of [
      `</3d/api/projects> (<${token}>)`,
      `</3d/dav/..%2f..%2foutside.txt> (<${token}>)`,
      `</3d/dav/..;/outside.txt> (<${token}>)`,
      `<http://editor.example/other/dav/refused.txt> (<${token}>)`,
      `<ftp://editor.example/3d/dav/refused.txt> (<${token}>)`,
      `<${dav.origin}/guarded/refused.txt> (<${token}>)`,
      // one tag outside among tags inside
      `</3d/dav/refused.txt> (<${token}>) </3d/sync/x> (<${token}>)`,
    ]) {
      for (const method of ['PUT', 'DELETE', 'PROPPATCH']) {
        const body = method === 'DELETE' ? undefined : 'refused';
        res = await request(editorUrl('refused.txt'), { method, headers: { if: header }, body });
        expect(res.status, `${method} ${header}`).toBe(502);
        expect(JSON.parse(res.body), header).toEqual(OUTSIDE);
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
    ]) {
      res = await request(editorUrl('refused.txt'), {
        method: 'PUT',
        headers: { if: header },
        body: 'refused',
      });
      expect(res.status, JSON.stringify(header)).toBe(400);
      expect(JSON.parse(res.body), header).toEqual({ error: 'invalid If header' });
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
