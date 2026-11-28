import http, { type IncomingHttpHeaders } from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../helpers/app';
import { mkcolPath, startWebDAV, type TestWebDAV } from '../helpers/webdav';

/*
 * The WebDAV proxy reaches nothing outside WEBDAV_URL (dav/rewrite.ts): a segment of a request path
 * or of a Destination that decodes to something with a '/' in it (`..%2f`), a backslash or a
 * control character, or to a dot segment (also before a `;`: `..;`), or that does not decode, is
 * refused before anything is sent to the WebDAV server; a server that decodes %2F (as
 * webdav-server, the fixture here, does) would read `..%2f` as a way out of the folder, a servlet
 * container `..;`, and the URL parser drops a tab (`.\t.`). The URL as built is checked too: the
 * parser trims a space at the end of what it reads. Names with encoded spaces, UTF-8 and `;` still
 * work, under the base and without it.
 */

const SECRET = 'TOP SECRET OUTSIDE';

let dav: TestWebDAV;
let server: TestServer;
/**
 * Every request the WebDAV server got from the editor server during the current test: method, path as
 * decoded, Destination.
 */
const upstream: { method: string; path: string; destination?: string }[] = [];

beforeAll(async () => {
  dav = await startWebDAV({
    onRequest: ({ method, path, headers }) => {
      // the proxy's own requests (this test reads the WebDAV server directly too)
      if (headers['user-agent'] !== '3d-editor-server (webdav proxy)') return;
      upstream.push({ method, path, destination: headers.destination as string | undefined });
    },
  });
  await mkcolPath(dav, '/guarded/x');
  const auth = { authorization: dav.authorization };
  // a file outside the folder the editor server is given, and one inside it
  for (const [p, body] of [
    ['/outside-secret.txt', SECRET],
    ['/guarded/inside.txt', 'inside'],
  ]) {
    const res = await fetch(`${dav.origin}${p}`, { method: 'PUT', headers: auth, body });
    expect(res.status).toBeLessThan(300);
  }
  server = await startServer({
    WEBDAV_URL: `${dav.origin}/guarded`,
    WEBDAV_USERNAME: dav.username,
    WEBDAV_PASSWORD: dav.password,
    SYNC_PERSISTENCE: 'memory',
    BASE_PATH: '/3d',
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

/** A request with this exact target (fetch would normalise some), to the editor server. */
function request(
  target: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
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

/**
 * Sends these bytes to the editor server as they are (no client checks them) and gives the status
 * code of the answer, 0 when none comes.
 */
function rawExchange(bytes: string): Promise<number> {
  return new Promise((resolve) => {
    const socket = net.connect(server.port, '127.0.0.1');
    let data = '';
    const done = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0));
    };
    const timer = setTimeout(done, 5000);
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      data += chunk;
      if (data.includes('\r\n')) done();
    });
    socket.on('error', done);
    socket.on('close', done);
    socket.write(bytes, 'latin1');
  });
}

/** The paths of the WebDAV server's root, as its PROPFIND lists them. */
async function upstreamRoot(): Promise<string[]> {
  const res = await fetch(`${dav.origin}/`, {
    method: 'PROPFIND',
    headers: { authorization: dav.authorization, depth: '1' },
  });
  const xml = await res.text();
  return [...xml.matchAll(/<(?:\w+:)?href>([^<]*)</g)]
    .map((m) => decodeURIComponent(new URL(m[1]!, dav.origin).pathname))
    .sort();
}

/** A file on the WebDAV server, or null. */
async function upstreamFile(p: string): Promise<string | null> {
  const res = await fetch(`${dav.origin}${p}`, { headers: { authorization: dav.authorization } });
  return res.status === 200 ? res.text() : null;
}

describe('the WebDAV proxy keeps to WEBDAV_URL', () => {
  it('refuses request paths that leave the folder through an encoded slash or backslash, for every method', async () => {
    for (const prefix of ['/dav', '/3d/dav']) {
      const cases: [string, string, Record<string, string>?, string?][] = [
        ['GET', `${prefix}/..%2foutside-secret.txt`],
        ['GET', `${prefix}/..%2Foutside-secret.txt`],
        ['GET', `${prefix}/x/..%2f..%2foutside-secret.txt`],
        ['GET', `${prefix}/x%2f..%2f..%2foutside-secret.txt`],
        ['GET', `${prefix}/%2e%2e%2foutside-secret.txt`],
        ['GET', `${prefix}/.%2e%2foutside-secret.txt`],
        ['GET', `${prefix}/..%5coutside-secret.txt`],
        ['HEAD', `${prefix}/..%2foutside-secret.txt`],
        ['PROPFIND', `${prefix}/..%2f`, { depth: '1' }],
        ['PROPFIND', `${prefix}/x/..%2f..%2f`, { depth: 'infinity' }],
        ['PUT', `${prefix}/..%2fwritten-outside.txt`, {}, 'written'],
        ['PUT', `${prefix}/x/..%2f..%2fwritten-outside.txt`, {}, 'written'],
        ['MKCOL', `${prefix}/..%2fmade-outside`],
        ['DELETE', `${prefix}/..%2foutside-secret.txt`],
        ['DELETE', `${prefix}/x%2f..%2f..%2foutside-secret.txt`],
        ['COPY', `${prefix}/..%2foutside-secret.txt`, { destination: '/dav/copied-in.txt' }],
        ['MOVE', `${prefix}/x/..%2f..%2foutside-secret.txt`, { destination: '/3d/dav/moved-in.txt' }],
      ];
      for (const [method, target, headers, body] of cases) {
        const res = await request(target, { method, headers, body });
        expect(res.status, `${method} ${target}`).toBe(400);
        if (method !== 'HEAD')
          expect(JSON.parse(res.body), `${method} ${target}`).toEqual({ error: 'invalid WebDAV path' });
      }
    }
    expect(upstream).toEqual([]);
  });

  it('refuses Destinations that leave the folder or do not decode (502), for COPY and MOVE', async () => {
    for (const destination of [
      '/dav/..%2fpwned1.txt',
      '/3d/dav/..%2Fpwned2.txt',
      '/dav/%2e%2e%2fpwned3.txt',
      '/dav/..%5cpwned4.txt',
      'http://h/dav/x/..%2f..%2fpwned5.txt',
      'https://h/3d/dav/x%2f..%2f..%2fpwned6.txt',
      '/dav/%%%%',
      `/3d/dav/${'%'.repeat(1000)}`,
      '/dav/x%C3',
    ]) {
      for (const method of ['COPY', 'MOVE']) {
        const res = await request('/3d/dav/inside.txt', { method, headers: { destination } });
        expect(res.status, `${method} ${destination}`).toBe(502);
        expect(JSON.parse(res.body), destination).toEqual({ error: 'Destination must be inside /3d/dav/' });
      }
    }
    expect(upstream).toEqual([]);
  });

  it('refuses `..;` segments, which servlet containers resolve as `..`, in request paths and Destinations', async () => {
    for (const prefix of ['/dav', '/3d/dav']) {
      const cases: [string, string, Record<string, string>?, string?][] = [
        ['GET', `${prefix}/..;/outside-secret.txt`],
        ['GET', `${prefix}/x/..;x/..;/outside-secret.txt`],
        ['GET', `${prefix}/..%3b/outside-secret.txt`],
        ['GET', `${prefix}/%2e%2e;/outside-secret.txt`],
        ['GET', `${prefix}/%2e%2e%3b/outside-secret.txt`],
        ['HEAD', `${prefix}/..;jsessionid=1/outside-secret.txt`],
        ['PROPFIND', `${prefix}/..;/`, { depth: '1' }],
        ['PUT', `${prefix}/..;/written-outside.txt`, {}, 'written'],
        ['PUT', `${prefix}/x/.;/..;/written-outside.txt`, {}, 'written'],
        ['MKCOL', `${prefix}/..%3B/made-outside`],
        ['DELETE', `${prefix}/..;/outside-secret.txt`],
        ['COPY', `${prefix}/..;/outside-secret.txt`, { destination: '/dav/copied-in.txt' }],
        ['MOVE', `${prefix}/..;/outside-secret.txt`, { destination: '/3d/dav/moved-in.txt' }],
      ];
      for (const [method, target, headers, body] of cases) {
        const res = await request(target, { method, headers, body });
        expect(res.status, `${method} ${target}`).toBe(400);
      }
    }
    for (const destination of [
      '/dav/..;/pwned-semi1.txt',
      '/3d/dav/x/..;x/..;/pwned-semi2.txt',
      '/dav/..%3b/pwned-semi3.txt',
      'http://h/3d/dav/%2e%2e;/pwned-semi4.txt',
      '/dav/x/.;/pwned-semi5.txt',
      '/dav/%2e%2e%3b/pwned-semi6.txt',
    ]) {
      for (const method of ['COPY', 'MOVE']) {
        const res = await request('/3d/dav/inside.txt', { method, headers: { destination } });
        expect(res.status, `${method} ${destination}`).toBe(502);
      }
    }
    expect(upstream).toEqual([]);
  });

  it('refuses control characters: `%09` and the like in paths and Destinations, a raw tab in a Destination', async () => {
    for (const prefix of ['/dav', '/3d/dav']) {
      const cases: [string, string, Record<string, string>?, string?][] = [
        ['GET', `${prefix}/.%09./outside-secret.txt`],
        ['GET', `${prefix}/x/.%09./.%09./outside-secret.txt`],
        ['PUT', `${prefix}/x/.%09./tab-written.txt`, {}, 'written'],
        ['PROPFIND', `${prefix}/.%09./`, { depth: '1' }],
        ['DELETE', `${prefix}/x/.%0A./inside.txt`],
        ['GET', `${prefix}/inside.txt%0D`],
        ['GET', `${prefix}/%7F`],
      ];
      for (const [method, target, headers, body] of cases) {
        const res = await request(target, { method, headers, body });
        expect(res.status, `${method} ${target}`).toBe(400);
      }
    }
    // a header value may carry a raw tab, and the URL parser drops it: `.\t.` would be sent as `..`
    for (const destination of [
      '/3d/dav/.\t./pwned-tab1.txt',
      '/dav/x/.\t./tab-inside.txt',
      '/3d/dav/x\t/tab-name.txt',
      'http://h/3d/dav/x/.\t./.\t./pwned-tab2.txt',
      '/3d/dav/.%09./pwned-tab3.txt',
      '/dav/x/%09/pwned-tab4.txt',
    ]) {
      for (const method of ['COPY', 'MOVE']) {
        const res = await request('/3d/dav/inside.txt', { method, headers: { destination } });
        expect(res.status, `${method} ${JSON.stringify(destination)}`).toBe(502);
      }
    }
    // no other control character reaches the proxy: Node's HTTP parser refuses CR and LF in a
    // header value, a folded line and a line that ends without its CR (400)
    for (const [method, destination] of [
      ['COPY', '/3d/dav/.\n./pwned-lf1.txt'],
      ['MOVE', '/3d/dav/.\r./pwned-cr.txt'],
      ['COPY', '/3d/dav/.\r\n\t./pwned-fold.txt'],
      ['COPY', '/3d/dav/.\t./pwned-lf2.txt\nX-Line: 1'],
      ['MOVE', '/3d/dav/.\u000b./pwned-vt.txt'],
    ]) {
      const status = await rawExchange(
        `${method} /3d/dav/inside.txt HTTP/1.1\r\nHost: 127.0.0.1\r\nDestination: ${destination}\r\n\r\n`,
      );
      expect([400, 502], `${method} ${JSON.stringify(destination)}`).toContain(status);
    }
    expect(upstream).toEqual([]);
  });

  it('refuses a Destination that the URL parser reads as a way out: a path that ends in a space before its fragment', async () => {
    // `.. ` is a name to the segment check, but the URL parser trims a space at the end of what it
    // reads (the fragment cut off first): `/guarded/.. ` would be built as `/guarded/..`, that is `/`
    for (const destination of ['/3d/dav/.. #f', '/dav/.%2e #f']) {
      for (const method of ['COPY', 'MOVE']) {
        const res = await request('/3d/dav/inside.txt', { method, headers: { destination } });
        expect(res.status, `${method} ${destination}`).toBe(502);
      }
    }
    expect(upstream).toEqual([]);
  });

  it('read, wrote, moved and deleted nothing outside the folder', async () => {
    expect(await upstreamRoot()).toEqual(['/', '/guarded/', '/outside-secret.txt']);
    expect(await upstreamFile('/outside-secret.txt')).toBe(SECRET);
    expect(await upstreamFile('/guarded/inside.txt')).toBe('inside');
  });

  it('still serves names with encoded spaces and UTF-8, under the base and without it', async () => {
    let res = await request('/3d/dav/a%20b.txt', { method: 'PUT', body: 'space' });
    expect(res.status).toBe(201);
    res = await request('/dav/caf%C3%A9.txt', { method: 'PUT', body: 'utf-8' });
    expect(res.status).toBe(201);
    expect((await request('/dav/a%20b.txt')).body).toBe('space');
    expect((await request('/3d/dav/caf%C3%A9.txt')).body).toBe('utf-8');
    res = await request('/3d/dav/', { method: 'PROPFIND', headers: { depth: '1' } });
    expect(res.status).toBe(207);
    expect(res.body).toContain('/3d/dav/a%20b.txt');
    expect(res.body).toContain('/3d/dav/caf%C3%A9.txt');
    // a Destination spelled as a request target may be (/%33d is /3d), absolute or not
    res = await request('/3d/dav/a%20b.txt', {
      method: 'COPY',
      headers: { destination: '/%33d/dav/a%20copy.txt' },
    });
    expect(res.status).toBe(201);
    res = await request('/dav/caf%C3%A9.txt', {
      method: 'MOVE',
      headers: { destination: 'http://editor.example/3d/dav/x/caf%C3%A9.txt' },
    });
    expect(res.status).toBe(201);
    expect(await upstreamFile('/guarded/a%20copy.txt')).toBe('space');
    expect(await upstreamFile('/guarded/x/caf%C3%A9.txt')).toBe('utf-8');
    res = await request('/3d/dav/x/caf%C3%A9.txt', { method: 'DELETE' });
    expect(res.status).toBeLessThan(300);
    expect(await upstreamFile('/guarded/x/caf%C3%A9.txt')).toBeNull();
    // every request the WebDAV server got was inside the folder
    expect(upstream.length).toBeGreaterThan(0);
    for (const r of upstream) {
      expect(r.path.startsWith('/guarded'), r.path).toBe(true);
      expect(r.path.split('/'), r.path).not.toContain('..');
      if (r.destination) expect(r.destination.startsWith(`${dav.origin}/guarded/`), r.destination).toBe(true);
    }
    expect(await upstreamRoot()).toEqual(['/', '/guarded/', '/outside-secret.txt']);
  });

  it('still serves names that hold a `;`', async () => {
    let res = await request('/3d/dav/a;b.txt', { method: 'PUT', body: 'semicolon' });
    expect(res.status).toBe(201);
    expect((await request('/dav/a;b.txt')).body).toBe('semicolon');
    expect((await request('/3d/dav/a%3Bb.txt')).body).toBe('semicolon');
    res = await request('/3d/dav/', { method: 'PROPFIND', headers: { depth: '1' } });
    expect(res.status).toBe(207);
    expect(res.body).toContain('/3d/dav/a%3Bb.txt');
    res = await request('/3d/dav/a;b.txt', { method: 'COPY', headers: { destination: '/3d/dav/x/c;d.txt' } });
    expect(res.status).toBe(201);
    expect(await upstreamFile('/guarded/a;b.txt')).toBe('semicolon');
    expect(await upstreamFile('/guarded/x/c;d.txt')).toBe('semicolon');
    // every request the WebDAV server got was the folder or under it (paths decoded, without the
    // slash at the end)
    expect(upstream.length).toBeGreaterThan(0);
    for (const r of upstream) {
      expect(r.path === '/guarded' || r.path.startsWith('/guarded/'), r.path).toBe(true);
      if (r.destination) expect(r.destination, r.destination).toBe(`${dav.origin}/guarded/x/c;d.txt`);
    }
    expect(await upstreamRoot()).toEqual(['/', '/guarded/', '/outside-secret.txt']);
  });
});
