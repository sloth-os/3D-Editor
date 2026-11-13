import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ToolError } from '../../src/mcp/agent';
import {
  STORE_USER_AGENT,
  StoreCancelledError,
  StoreHostRefusedError,
  StoreUpstreamError,
  checkStoreUrl,
  dnsResolver,
  formatBytes,
  guardedFetch,
  isForbiddenHost,
  isPrivateAddress,
  sniffImage,
  storeFetch,
  storeFetchJson,
  storeFetchToFile,
  type StoreFetchOptions,
} from '../../src/store/http';
import { bytes, fakeFetch, hang, json, tempDir, tinyPng, type Route } from './store-fixtures';

/*
 * The store's outbound requests: allowed URLs and hosts (also after redirects, which drop
 * credentials on other origins), size caps, content checks, the timeouts to the headers and
 * between chunks, cancellation, and streaming to a file with hashes.
 */

const A = 'https://a.example.org';
const B = 'https://b.example.org';

const opts = (fetchImpl: typeof fetch, over: Partial<StoreFetchOptions> = {}): StoreFetchOptions => ({
  what: 'test file',
  timeoutMs: 1000,
  maxBytes: 1 << 20,
  expect: 'file',
  fetchImpl,
  ...over,
});

const redirect =
  (to: string, status = 302): Route =>
  () =>
    new Response(null, { status, headers: { location: to } });

/** A body that sends `first`, then nothing until the request is aborted. */
const stall =
  (first: Uint8Array): Route =>
  ({ signal }) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(first);
          signal?.addEventListener('abort', () => c.error(signal.reason));
        },
        pull: () => new Promise<void>(() => undefined),
      }),
      { headers: { 'content-type': 'application/octet-stream' } },
    );

async function failure(p: Promise<unknown>): Promise<StoreUpstreamError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof StoreUpstreamError) return err;
    throw err;
  }
  throw new Error('resolved');
}

describe('hosts and URLs', () => {
  it('refuses cloud metadata hosts in every spelling', () => {
    for (const h of [
      '169.254.169.254',
      '169.254.0.1',
      '[::ffff:169.254.169.254]',
      '::ffff:a9fe:a9fe',
      'metadata.google.internal',
      'metadata.google.internal.',
      'METADATA',
      'fd00:ec2::254',
    ])
      expect(isForbiddenHost(h), h).toBe(true);
    for (const h of ['example.org', '10.0.0.1', '127.0.0.1', '::1', 'metadata.example.org'])
      expect(isForbiddenHost(h), h).toBe(false);
  });

  it('fetches only http and https', () => {
    expect(checkStoreUrl('https://x.example.org/a', 'x').href).toBe('https://x.example.org/a');
    for (const bad of [
      'file:///etc/passwd',
      'ftp://x.example.org/a',
      'data:text/plain,hi',
      'not a url',
      'http://169.254.169.254/latest',
    ])
      expect(() => checkStoreUrl(bad, 'x'), bad).toThrow(StoreUpstreamError);
  });
});

describe('public servers only (guardedFetch)', () => {
  it('knows loopback, private, link-local and other non-public addresses in every spelling', () => {
    for (const ip of [
      '127.0.0.1',
      '127.8.9.10',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '[::1]',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1%eth0',
      'fec0::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '[::ffff:a00:1]',
      '::127.0.0.1',
      '64:ff9b::a00:1',
      '2002:c0a8:101::1',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of [
      '93.184.216.34',
      '8.8.8.8',
      '172.32.0.1',
      '100.128.0.1',
      '2606:4700::1111',
      '::ffff:93.184.216.34',
      '2002:5db8:d822::1',
      'example.org',
    ])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses local hosts on every request and redirect, also by name, before asking them', async () => {
    const names: Record<string, string[]> = {
      'a.example.org': ['93.184.216.34'],
      'b.example.org': ['2606:4700::1111'],
      'intranet.example.org': ['10.1.2.3'],
      'mixed.example.org': ['93.184.216.34', '::ffff:127.0.0.1'],
    };
    const ok = bytes(new Uint8Array([1]));
    const f = fakeFetch({
      [`${A}/x`]: ok,
      [`${B}/x`]: ok,
      [`${A}/to-lan`]: redirect('http://10.0.0.5:8080/admin'),
      [`${A}/to-name`]: redirect('https://intranet.example.org/x'),
      [`${A}/to-v6`]: redirect('http://[::ffff:7f00:1]:2375/containers/json'),
      [`${A}/to-number`]: redirect('http://2130706433/'),
      'http://10.0.0.5:8080/admin': ok,
      'https://intranet.example.org/x': ok,
      'https://mixed.example.org/x': ok,
      'http://localhost:3000/x': ok,
      'http://a.localhost/x': ok,
      'http://192.168.1.20:8080/c.json': ok,
      'http://192.168.1.20:8081/c.json': ok,
    });
    const g = guardedFetch(f.fetch, {
      resolve: async (h) => names[h] ?? [],
      trusted: new Set(['http://192.168.1.20:8080']),
    });
    const refused = async (url: string) => {
      const err = await failure(storeFetch(url, opts(g)));
      expect(err, url).toBeInstanceOf(StoreHostRefusedError);
      expect(err.code).toBe('UPSTREAM');
      return err.message;
    };
    expect([...(await storeFetch(`${A}/x`, opts(g))).data]).toEqual([1]);
    expect([...(await storeFetch(`${B}/x`, opts(g))).data]).toEqual([1]);
    expect(await refused(`${A}/to-lan`)).toBe(
      'test file: fetching from 10.0.0.5:8080 is not allowed: it is a private or local address (the model store fetches only from public servers)',
    );
    expect(await refused(`${A}/to-name`)).toMatch(/resolves to 10\.1\.2\.3, a private or local address/);
    expect(await refused(`${A}/to-v6`)).toMatch(/private or local address/);
    expect(await refused(`${A}/to-number`)).toMatch(/127\.0\.0\.1 is not allowed/);
    expect(await refused('https://mixed.example.org/x')).toMatch(/resolves to ::ffff:127\.0\.0\.1/);
    expect(await refused('http://localhost:3000/x')).toMatch(/it is this machine/);
    expect(await refused('http://a.localhost/x')).toMatch(/it is this machine/);
    // a configured catalog's origin is reached whatever its address; its other ports are not it
    expect([...(await storeFetch('http://192.168.1.20:8080/c.json', opts(g))).data]).toEqual([1]);
    await refused('http://192.168.1.20:8081/c.json');
    // none of the refused hosts was asked anything
    expect(f.calls.map((c) => new URL(c.url).host).filter((h) => !h.endsWith('example.org'))).toEqual([
      '192.168.1.20:8080',
    ]);
    expect(f.count('https://intranet.example.org')).toBe(0);
    expect(f.count('https://mixed.example.org')).toBe(0);
  });

  it('checks addresses without a resolver, and lets the request decide when a name does not resolve', async () => {
    const f = fakeFetch({
      [`${A}/x`]: bytes(new Uint8Array([1])),
      'http://127.0.0.1/x': bytes(new Uint8Array([1])),
    });
    const plain = guardedFetch(f.fetch, { resolve: null });
    expect((await storeFetch(`${A}/x`, opts(plain))).data).toHaveLength(1);
    expect((await failure(storeFetch('http://127.0.0.1/x', opts(plain)))).message).toMatch(/not allowed/);
    const failing = guardedFetch(f.fetch, {
      resolve: async () => {
        throw new Error('no DNS');
      },
    });
    expect((await storeFetch(`${A}/x`, opts(failing))).data).toHaveLength(1);
  });

  it('resolves names with the system resolver', async () => {
    const addresses = await dnsResolver()('localhost');
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.every((a) => isPrivateAddress(a))).toBe(true);
  });
});

describe('storeFetch', () => {
  it('names itself and returns the body', async () => {
    const f = fakeFetch({ [`${A}/x`]: bytes(new Uint8Array([1, 2, 3])) });
    const r = await storeFetch(`${A}/x`, opts(f.fetch));
    expect([...r.data]).toEqual([1, 2, 3]);
    expect(f.calls[0].headers['user-agent']).toBe(STORE_USER_AGENT);
  });

  it('follows redirects by hand, sending credentials to the first origin only', async () => {
    const f = fakeFetch({
      [`${A}/start`]: redirect(`${A}/same`),
      [`${A}/same`]: redirect(`${B}/other`, 307),
      [`${B}/other`]: bytes(new Uint8Array([9])),
    });
    const r = await storeFetch(
      `${A}/start`,
      opts(f.fetch, { headers: { authorization: 'Token t', accept: 'x/y' } }),
    );
    expect(r.url).toBe(`${B}/other`);
    expect(f.calls.map((c) => [c.url, c.headers.authorization ?? null, c.headers.accept])).toEqual([
      [`${A}/start`, 'Token t', 'x/y'],
      [`${A}/same`, 'Token t', 'x/y'],
      [`${B}/other`, null, 'x/y'],
    ]);
  });

  it('refuses redirects to metadata hosts or other schemes, and too many redirects', async () => {
    const meta = fakeFetch({ [`${A}/x`]: redirect('http://169.254.169.254/latest/meta-data/') });
    expect((await failure(storeFetch(`${A}/x`, opts(meta.fetch)))).message).toMatch(/not allowed/);
    expect(meta.calls).toHaveLength(1);
    const scheme = fakeFetch({ [`${A}/x`]: redirect('file:///etc/passwd') });
    expect((await failure(storeFetch(`${A}/x`, opts(scheme.fetch)))).message).toMatch(/only http and https/);
    const loop = fakeFetch({ [`${A}/x`]: redirect(`${A}/x`) });
    expect((await failure(storeFetch(`${A}/x`, opts(loop.fetch)))).message).toMatch(/too many redirects/);
    expect(loop.calls).toHaveLength(6);
  });

  it('reports HTTP errors with their status and HTML pages as errors', async () => {
    const f = fakeFetch({
      [`${A}/gone`]: () => new Response('gone', { status: 404 }),
      [`${A}/login`]: () =>
        new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    });
    const e404 = await failure(storeFetch(`${A}/gone`, opts(f.fetch)));
    expect(e404.status).toBe(404);
    expect(e404.code).toBe('UPSTREAM');
    expect((await failure(storeFetch(`${A}/login`, opts(f.fetch)))).message).toMatch(/HTML page/);
  });

  it('caps the size by Content-Length and while streaming', async () => {
    const data = new Uint8Array(2000);
    const declared = fakeFetch({ [`${A}/x`]: bytes(data) });
    const e1 = await failure(storeFetch(`${A}/x`, opts(declared.fetch, { maxBytes: 1000 })));
    expect(e1.tooLarge).toBe(true);
    const chunked = fakeFetch({
      [`${A}/x`]: () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(500));
              c.close();
            },
          }),
        ),
    });
    const e2 = await failure(storeFetch(`${A}/x`, opts(chunked.fetch, { maxBytes: 1000 })));
    expect(e2.tooLarge).toBe(true);
    expect(e2.message).toMatch(/larger than 1000 bytes/);
  });

  it('times out waiting for the headers and when a body stalls', async () => {
    const f = fakeFetch({ [`${A}/hang`]: hang, [`${A}/stall`]: stall(new Uint8Array(10)) });
    let t0 = performance.now();
    const e1 = await failure(storeFetch(`${A}/hang`, opts(f.fetch, { timeoutMs: 120 })));
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(e1.timeout).toBe(true);
    expect(e1.message).toMatch(/no answer within 0.1 s/);
    t0 = performance.now();
    const e2 = await failure(storeFetch(`${A}/stall`, opts(f.fetch, { timeoutMs: 120 })));
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(e2.timeout).toBe(true);
    expect(e2.message).toMatch(/stalled/);
  });

  it('keeps a slow body that keeps moving (the timeout is per chunk)', async () => {
    const f = fakeFetch({
      [`${A}/slow`]: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(c) {
              for (let i = 0; i < 5; i++) {
                await new Promise((r) => setTimeout(r, 40));
                c.enqueue(new Uint8Array([i]));
              }
              c.close();
            },
          }),
        ),
    });
    const r = await storeFetch(`${A}/slow`, opts(f.fetch, { timeoutMs: 120 }));
    expect([...r.data]).toEqual([0, 1, 2, 3, 4]);
  });

  it('stops when the caller goes away', async () => {
    const f = fakeFetch({ [`${A}/hang`]: hang });
    const abort = new AbortController();
    const p = storeFetch(`${A}/hang`, opts(f.fetch, { signal: abort.signal }));
    abort.abort();
    await expect(p).rejects.toBeInstanceOf(StoreCancelledError);
  });

  it('checks images by their bytes and JSON by parsing it', async () => {
    const f = fakeFetch({
      [`${A}/png`]: bytes(tinyPng(), 'image/png'),
      [`${A}/fake`]: bytes(new TextEncoder().encode('GIF? no'), 'image/png'),
      [`${A}/pdf`]: bytes(new Uint8Array([1]), 'application/pdf'),
      [`${A}/j`]: json({ a: 1 }),
      [`${A}/notjson`]: bytes(new TextEncoder().encode('{oops'), 'application/json'),
    });
    expect((await storeFetch(`${A}/png`, opts(f.fetch, { expect: 'image' }))).data.length).toBeGreaterThan(8);
    expect((await failure(storeFetch(`${A}/fake`, opts(f.fetch, { expect: 'image' })))).message).toMatch(
      /not an image/,
    );
    expect((await failure(storeFetch(`${A}/pdf`, opts(f.fetch, { expect: 'image' })))).message).toMatch(
      /expected an image, got application\/pdf/,
    );
    expect(await storeFetchJson(`${A}/j`, opts(f.fetch))).toEqual({ a: 1 });
    expect(f.calls.at(-1)?.headers.accept).toBe('application/json');
    expect((await failure(storeFetchJson(`${A}/notjson`, opts(f.fetch)))).message).toMatch(/not JSON/);
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(new TextEncoder().encode('<svg'))).toBeNull();
  });

  it('turns network failures into UPSTREAM errors naming what failed', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND a.example.org') });
    }) as unknown as typeof fetch;
    const err = await failure(storeFetch(`${A}/x`, opts(failing)));
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toBe('test file: request failed (getaddrinfo ENOTFOUND a.example.org)');
  });
});

describe('storeFetchToFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir('store-http-');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('streams to a file with sizes and hashes', async () => {
    const data = new Uint8Array(300_000).map((_, i) => i * 7);
    const f = fakeFetch({ [`${A}/m.glb`]: bytes(data) });
    const file = path.join(dir, 'm.glb');
    const r = await storeFetchToFile(`${A}/m.glb`, file, opts(f.fetch));
    expect(r.bytes).toBe(300_000);
    expect(r.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    expect(r.md5).toBe(createHash('md5').update(data).digest('hex'));
    expect([...r.head]).toEqual([...data.subarray(0, 64)]);
    expect(new Uint8Array(await readFile(file))).toEqual(data);
  });

  it('stops at the size cap while streaming', async () => {
    const f = fakeFetch({
      [`${A}/big`]: () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(1000));
              c.close();
            },
          }),
        ),
    });
    const err = await failure(
      storeFetchToFile(`${A}/big`, path.join(dir, 'x'), opts(f.fetch, { maxBytes: 4500 })),
    );
    expect(err.tooLarge).toBe(true);
  });
});

describe('formatBytes', () => {
  it('reads like a size', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(200 * 1024 * 1024)).toBe('200 MB');
  });
});
