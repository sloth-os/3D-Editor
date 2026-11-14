import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StoreResult } from '@3d-editor/core';
import { ToolError } from '../../src/mcp/agent';
import type { ServiceContext } from '../../src/services';
import { ModelStore, MAX_STORE_RESULTS, thumbnailPath } from '../../src/store';
import { StoreCancelledError, StoreUpstreamError } from '../../src/store/http';
import { decodeCursor, encodeCursor, mergePages, searchKey } from '../../src/store/search';
import type { ModelProvider, ProviderPage, ProviderQuery } from '../../src/store/providers/types';
import { pageOf } from '../../src/store/providers/types';
import { relevance } from '../../src/store/relevance';
import { cacheHash } from '../../src/store/cache';
import { parsePolyhavenAssets } from '../../src/store/providers/polyhaven';
import {
  KHRONOS,
  KHRONOS_CHAIR_META,
  KHRONOS_INDEX,
  POLYHAVEN_API,
  POLYHAVEN_ASSETS,
  fakeFetch,
  hang,
  json,
  makeStore,
  type Route,
  type TestStore,
} from './store-fixtures';

/*
 * Searching: the merge of provider pages (order, ties, exact next offsets, duplicates), the cursor
 * (opaque, tied to its search), limits, and how failing, slow, keyless or disabled providers are
 * reported per provider while the others still answer.
 */

const model = (provider: string, id: string, name: string, thumb = true): StoreResult => ({
  id: `${provider}:${id}`,
  provider,
  name,
  category: 'furniture',
  tags: [],
  thumbnail_url: thumb ? `https://img.example.org/${id}.png` : null,
  license: { spdx: 'CC0-1.0', url: null, attribution: null },
  author: null,
  source_url: null,
  dimensions_m: null,
  triangles: null,
  formats: provider === 'builtin' ? ['builtin'] : ['glb'],
  downloadable: true,
});

type Search = (q: ProviderQuery) => Promise<ProviderPage>;

/** A provider over `names` (scored by relevance like the real ones), or with its own search. */
function fakeProvider(
  id: ModelProvider['id'],
  names: string[],
  o: { search?: Search; missingKey?: string; searchesWithoutKey?: boolean } = {},
): ModelProvider & { queries: ProviderQuery[] } {
  const all = names.map((n, i) => model(id, `${id}-${i}`, n, i % 2 === 0));
  const queries: ProviderQuery[] = [];
  return {
    id,
    name: `Fake ${id}`,
    queries,
    missingKey: () => o.missingKey ?? null,
    searchesWithoutKey: () => o.searchesWithoutKey ?? true,
    async search(q) {
      queries.push(q);
      if (o.search) return o.search(q);
      const ranked = all
        .map((m) => ({ model: m, score: relevance(q.words, { name: m.name }) }))
        .filter((r) => !q.words.length || r.score > 0)
        .sort((a, b) => b.score - a.score);
      return pageOf(ranked, q);
    },
    details: async () => {
      throw new Error('not used');
    },
    thumbnail: async () => null,
    plan: async () => {
      throw new Error('not used');
    },
  };
}

let current: TestStore | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
});

async function storeWith(
  providers: Partial<Record<ModelProvider['id'], ModelProvider>>,
  env: Record<string, string> = {},
) {
  current = await makeStore({
    env: { STORE_PROVIDERS: Object.keys(providers).join(','), ...env },
    options: { providers },
  });
  return current.store;
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return err instanceof ToolError ? err.code : `not a ToolError: ${String(err)}`;
  }
  return 'resolved';
}

describe('mergePages', () => {
  const hit = (provider: string, id: string, score: number, next: number) => ({
    model: model(provider, id, id),
    score,
    next,
  });

  it('takes the best next result each step; ties go to the earlier provider', () => {
    const pages = new Map<string, ProviderPage>([
      ['khronos', { hits: [hit('khronos', 'k1', 5, 1), hit('khronos', 'k2', 1, 2)], end: 2 }],
      ['builtin', { hits: [hit('builtin', 'b1', 5, 1), hit('builtin', 'b2', 3, 2)], end: null }],
    ]);
    const r = mergePages(['builtin', 'khronos'], pages, { builtin: 0, khronos: 0 }, 3);
    expect(r.results.map((m) => m.id)).toEqual(['builtin:b1', 'khronos:k1', 'builtin:b2']);
    // builtin's page was used up (and it has nothing more); khronos continues after k1
    expect(r.offsets).toEqual({ builtin: null, khronos: 1 });
  });

  it('keeps the offsets of providers without a page and of providers nothing was taken from', () => {
    const pages = new Map<string, ProviderPage>([
      ['builtin', { hits: [hit('builtin', 'b1', 9, 11), hit('builtin', 'b2', 8, 12)], end: 12 }],
      ['polyhaven', { hits: [hit('polyhaven', 'p1', 1, 31)], end: 31 }],
    ]);
    const r = mergePages(
      ['builtin', 'polyhaven', 'khronos'],
      pages,
      { builtin: 10, polyhaven: 30, khronos: 7 },
      2,
    );
    expect(r.results.map((m) => m.id)).toEqual(['builtin:b1', 'builtin:b2']);
    expect(r.offsets).toEqual({ builtin: 12, polyhaven: 30, khronos: 7 });
  });

  it('shows a model listed twice once (its provider still moves on)', () => {
    const pages = new Map<string, ProviderPage>([
      [
        'sketchfab',
        {
          hits: [hit('sketchfab', 'a', 3, 1), hit('sketchfab', 'a', 2, 2), hit('sketchfab', 'b', 1, 3)],
          end: null,
        },
      ],
    ]);
    const r = mergePages(['sketchfab'], pages, { sketchfab: 0 }, 5);
    expect(r.results.map((m) => m.id)).toEqual(['sketchfab:a', 'sketchfab:b']);
    expect(r.offsets).toEqual({ sketchfab: null });
  });
});

describe('cursor', () => {
  it('round-trips and is tied to its search (query case and provider order do not matter)', () => {
    const key = searchKey(' Chair ', 'furniture', ['khronos', 'builtin']);
    expect(searchKey('chair', 'furniture', ['builtin', 'khronos'])).toBe(key);
    expect(searchKey('chair', null, ['builtin', 'khronos'])).not.toBe(key);
    const c = encodeCursor(key, { builtin: 20, khronos: null });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(c, key)).toEqual({ builtin: 20, khronos: null });
  });

  it('refuses malformed cursors and cursors of another search with INVALID_PARAMS', () => {
    const key = searchKey('chair', null, ['builtin']);
    const bad = [
      'not base64 json!',
      Buffer.from('{"v":2,"k":"x","o":{}}').toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, k: key, o: { builtin: -1 } })).toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, k: key, o: { builtin: 1.5 } })).toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, k: key, o: [] })).toString('base64url'),
    ];
    for (const c of bad) {
      expect(() => decodeCursor(c, key), c).toThrow(ToolError);
      try {
        decodeCursor(c, key);
      } catch (err) {
        expect((err as ToolError).code).toBe('INVALID_PARAMS');
      }
    }
    const other = encodeCursor(searchKey('table', null, ['builtin']), { builtin: 5 });
    expect(() => decodeCursor(other, key)).toThrow(/another search/);
  });
});

describe('ModelStore.search', () => {
  it('merges providers with built-in models first on ties and proxies thumbnails', async () => {
    const store = await storeWith({
      khronos: fakeProvider('khronos', ['Oak Chair', 'Lamp']),
      builtin: fakeProvider('builtin', ['Oak Chair', 'Sofa']),
    });
    const res = await store.search({ query: 'oak chair' });
    expect(res.results.map((r) => r.id)).toEqual(['builtin:builtin-0', 'khronos:khronos-0']);
    expect(res.results[0].thumbnail_url).toBe('/api/store/models/builtin:builtin-0/thumbnail');
    expect(res.results[1].thumbnail_url).toBe(thumbnailPath('khronos:khronos-0'));
    expect(res.providers.map((p) => [p.id, p.status])).toEqual([
      ['khronos', 'ok'],
      ['builtin', 'ok'],
    ]);
    expect(res.next_cursor).toBeNull();
  });

  it('gives external models without a thumbnail none (built-in ones always have one)', async () => {
    const store = await storeWith({
      builtin: fakeProvider('builtin', ['A', 'B']),
      khronos: fakeProvider('khronos', ['A', 'B']),
    });
    const res = await store.search({});
    const thumbs = Object.fromEntries(res.results.map((r) => [r.id, r.thumbnail_url]));
    expect(thumbs['builtin:builtin-1']).toBe('/api/store/models/builtin:builtin-1/thumbnail');
    expect(thumbs['khronos:khronos-1']).toBeNull();
    expect(thumbnailPath('catalog:a b/c')).toBe('/api/store/models/catalog:a%20b%2Fc/thumbnail');
  });

  it('pages through every result exactly once with next_cursor', async () => {
    const names = (p: string) => Array.from({ length: 13 }, (_, i) => `${p} chair ${i}`);
    const store = await storeWith({
      builtin: fakeProvider('builtin', names('Wood')),
      khronos: fakeProvider('khronos', names('Metal')),
      polyhaven: fakeProvider('polyhaven', names('Stone')),
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await store.search({ query: 'chair', limit: 7, cursor });
      expect(res.results.length).toBeLessThanOrEqual(7);
      seen.push(...res.results.map((r) => r.id));
      cursor = res.next_cursor ?? undefined;
      pages++;
    } while (cursor && pages < 20);
    expect(seen).toHaveLength(39);
    expect(new Set(seen).size).toBe(39);
    expect(pages).toBe(6);
  });

  it('clamps the limit to 1–50', async () => {
    const store = await storeWith({
      builtin: fakeProvider(
        'builtin',
        Array.from({ length: 80 }, (_, i) => `M${i}`),
      ),
    });
    expect((await store.search({ limit: 1000 })).results).toHaveLength(MAX_STORE_RESULTS);
    expect((await store.search({ limit: 0 })).results).toHaveLength(1);
    expect(MAX_STORE_RESULTS).toBe(50);
  });

  it('reports a failing provider and keeps it in the cursor while the others answer', async () => {
    let fail = true;
    const flaky = fakeProvider('polyhaven', ['Chair X', 'Chair Y'], {
      search: async (q) => {
        if (fail) throw new StoreUpstreamError('Poly Haven assets: HTTP 502');
        return pageOf([{ model: model('polyhaven', 'x', 'Chair X'), score: 1 }], q);
      },
    });
    const store = await storeWith({
      builtin: fakeProvider('builtin', ['Chair A', 'Chair B', 'Chair C']),
      polyhaven: flaky,
    });
    const first = await store.search({ query: 'chair', limit: 2 });
    expect(first.results.map((r) => r.id)).toEqual(['builtin:builtin-0', 'builtin:builtin-1']);
    expect(first.providers.find((p) => p.id === 'polyhaven')).toMatchObject({
      status: 'error',
      message: 'Poly Haven assets: HTTP 502',
    });
    // the next page asks Poly Haven again from its start
    fail = false;
    const second = await store.search({ query: 'chair', limit: 5, cursor: first.next_cursor! });
    expect(second.results.map((r) => r.id)).toEqual(['builtin:builtin-2', 'polyhaven:x']);
    expect(flaky.queries.map((q) => q.offset)).toEqual([0, 0]);
    expect(second.next_cursor).toBeNull();
    // GET /api/store/providers shows how each answered last
    expect((await store.providers()).find((p) => p.id === 'polyhaven')?.status).toBe('ok');
  });

  it('ends the cursor when every provider failed and nothing was found', async () => {
    const broken = (id: ModelProvider['id']) =>
      fakeProvider(id, [], { search: async () => Promise.reject(new Error('socket hang up')) });
    const store = await storeWith({ khronos: broken('khronos'), polyhaven: broken('polyhaven') });
    const res = await store.search({ query: 'chair' });
    expect(res.results).toEqual([]);
    expect(res.next_cursor).toBeNull();
    expect(res.providers.map((p) => p.status)).toEqual(['error', 'error']);
  });

  it('answers within STORE_FETCH_TIMEOUT_MS when a provider hangs (reported as timeout, its work aborted)', async () => {
    let aborted = false;
    const slow = fakeProvider('sketchfab', [], {
      search: () => new Promise<ProviderPage>(() => undefined),
    });
    const slowSearch = slow.search.bind(slow);
    slow.search = (q, env) => {
      env.signal?.addEventListener('abort', () => (aborted = true));
      return slowSearch(q, env);
    };
    const store = await storeWith(
      { builtin: fakeProvider('builtin', ['Chair']), sketchfab: slow },
      { STORE_FETCH_TIMEOUT_MS: '150' },
    );
    const t0 = performance.now();
    const res = await store.search({ query: 'chair' });
    const ms = performance.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(140);
    expect(ms).toBeLessThan(2000);
    expect(res.results.map((r) => r.id)).toEqual(['builtin:builtin-0']);
    expect(res.providers.find((p) => p.id === 'sketchfab')).toMatchObject({
      status: 'timeout',
      message: 'no answer within 0.15 s (STORE_FETCH_TIMEOUT_MS)',
    });
    expect(aborted).toBe(true);
    // the provider is asked again on the next page
    expect(res.next_cursor).not.toBeNull();
  });

  it('gives a provider that hangs the search deadline, not the download timeout, then a short wait', async () => {
    const f = fakeFetch({
      [`${KHRONOS}model-index.json`]: json(KHRONOS_INDEX),
      [`${KHRONOS}StudioChair/metadata.json`]: json(KHRONOS_CHAIR_META),
      [`${POLYHAVEN_API}/assets`]: hang,
    });
    current = await makeStore({
      fetch: f.fetch,
      env: { STORE_PROVIDERS: 'khronos,polyhaven', STORE_FETCH_TIMEOUT_MS: '20000' },
      options: { searchDeadlineMs: 1000 },
    });
    let t0 = performance.now();
    const first = await current.store.search({ query: 'chair' });
    const firstMs = performance.now() - t0;
    expect(firstMs).toBeGreaterThanOrEqual(950);
    expect(firstMs).toBeLessThan(5000);
    expect(first.results.map((r) => r.id)).toEqual(['khronos:StudioChair']);
    expect(first.providers.find((p) => p.id === 'polyhaven')).toMatchObject({
      status: 'timeout',
      message: 'no answer within 1 s (the search deadline)',
    });
    // while it cools down, a search waits a quarter of a second for it, not the whole deadline
    t0 = performance.now();
    const second = await current.store.search({ query: 'chair' });
    expect(performance.now() - t0).toBeLessThan(800);
    expect(second.results.map((r) => r.id)).toEqual(['khronos:StudioChair']);
    expect(second.providers.find((p) => p.id === 'polyhaven')).toMatchObject({
      status: 'timeout',
      message: expect.stringMatching(/searches wait at most 0\.25 s for it/),
    });
  });

  it('lets an index that takes longer than the deadline finish loading for a later search', async () => {
    const body = new TextEncoder().encode(JSON.stringify(POLYHAVEN_ASSETS));
    const loads = { started: 0, completed: 0, aborted: 0 };
    // 20 chunks 40 ms apart: never idle for long, but longer than the search's deadline
    const slow: Route = ({ signal }) => {
      loads.started++;
      let i = 0;
      const n = Math.ceil(body.length / 20);
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(ctl) {
            await new Promise((r) => setTimeout(r, 40));
            if (signal?.aborted) {
              loads.aborted++;
              ctl.error(signal.reason);
              return;
            }
            ctl.enqueue(body.subarray(i * n, (i + 1) * n));
            if (++i >= 20) {
              loads.completed++;
              ctl.close();
            }
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    };
    current = await makeStore({
      fetch: fakeFetch({ [`${POLYHAVEN_API}/assets`]: slow }).fetch,
      env: { STORE_PROVIDERS: 'polyhaven', STORE_FETCH_TIMEOUT_MS: '1000' },
      options: { searchDeadlineMs: 300 },
    });
    const first = await current.store.search({ query: 'chair' });
    expect(first.providers[0].status).toBe('timeout');
    expect(first.results).toEqual([]);
    // the load goes on without its search, and the next search finds the list
    await vi.waitFor(() => expect(loads.completed).toBe(1), { timeout: 4000 });
    const later = await current.store.search({ query: 'chair' });
    expect(later.results.map((r) => r.id)).toEqual(['polyhaven:Wooden_Chair_01']);
    expect(later.providers[0]).toMatchObject({ status: 'ok', message: null });
    expect(loads).toEqual({ started: 1, completed: 1, aborted: 0 });
  });

  it('answers from the expired index of a provider whose server hangs', async () => {
    current = await makeStore({
      fetch: fakeFetch({ [`${POLYHAVEN_API}/assets`]: hang }).fetch,
      env: { STORE_PROVIDERS: 'polyhaven', STORE_FETCH_TIMEOUT_MS: '20000' },
      options: { searchDeadlineMs: 300 },
    });
    // the list a server read two days ago (its disk cache)
    const index = path.join(current.config.modelCacheDir, 'index');
    await mkdir(index, { recursive: true });
    const fetchedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
    await writeFile(
      path.join(index, `polyhaven_assets-${cacheHash('polyhaven/assets').slice(0, 16)}.json`),
      JSON.stringify({
        fetched_at: fetchedAt,
        key: 'polyhaven/assets',
        data: parsePolyhavenAssets(POLYHAVEN_ASSETS),
      }),
    );
    const t0 = performance.now();
    const res = await current.store.search({ query: 'chair' });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(res.results.map((r) => r.id)).toEqual(['polyhaven:Wooden_Chair_01']);
    expect(res.providers[0]).toMatchObject({
      status: 'ok',
      message: `using the model list from ${new Date(fetchedAt).toISOString()} (the new copy is still loading)`,
    });
  });

  it('reports a provider whose request timed out as timeout', async () => {
    const store = await storeWith({
      khronos: fakeProvider('khronos', [], {
        search: async () =>
          Promise.reject(new StoreUpstreamError('model-index.json: no answer', { timeout: true })),
      }),
    });
    expect((await store.search({})).providers[0].status).toBe('timeout');
  });

  it('skips providers that need a key to search and says which setting', async () => {
    const pizza = fakeProvider('polypizza', ['Chair'], {
      missingKey: 'POLYPIZZA_API_KEY',
      searchesWithoutKey: false,
    });
    const sketchfab = fakeProvider('sketchfab', ['Chair'], { missingKey: 'SKETCHFAB_TOKEN' });
    const store = await storeWith({ polypizza: pizza, sketchfab });
    const res = await store.search({ query: 'chair' });
    expect(pizza.queries).toHaveLength(0);
    expect(res.results.map((r) => r.id)).toEqual(['sketchfab:sketchfab-0']);
    expect(res.providers).toEqual([
      {
        id: 'polypizza',
        name: 'Fake polypizza',
        enabled: true,
        status: 'needs_key',
        needs_key: 'POLYPIZZA_API_KEY',
        message: 'set POLYPIZZA_API_KEY to use Fake polypizza',
      },
      {
        id: 'sketchfab',
        name: 'Fake sketchfab',
        enabled: true,
        status: 'ok',
        needs_key: 'SKETCHFAB_TOKEN',
        message: 'searching works; downloads need SKETCHFAB_TOKEN',
      },
    ]);
    const listed = await store.providers();
    expect(listed.find((p) => p.id === 'sketchfab')).toMatchObject({
      status: 'ok',
      message: 'searching works; downloads need SKETCHFAB_TOKEN',
    });
    expect(listed.find((p) => p.id === 'catalog')).toMatchObject({
      enabled: false,
      status: 'disabled',
      message: 'STORE_CATALOG_URLS is not set',
    });
  });

  it('reports a provider refusing the key as needs_key', async () => {
    const store = await storeWith({
      polypizza: fakeProvider('polypizza', [], {
        search: async () =>
          Promise.reject(new ToolError('Poly Pizza refused POLYPIZZA_API_KEY', 'NEEDS_KEY')),
      }),
    });
    expect((await store.search({})).providers[0]).toMatchObject({
      status: 'needs_key',
      message: 'Poly Pizza refused POLYPIZZA_API_KEY',
    });
  });

  it('searches only the providers asked for; known but disabled ones are reported disabled', async () => {
    const builtin = fakeProvider('builtin', ['Chair']);
    const khronos = fakeProvider('khronos', ['Chair']);
    const store = await storeWith({ builtin, khronos });
    const res = await store.search({ query: 'chair', providers: ['KHRONOS', 'polyhaven', 'khronos'] });
    expect(builtin.queries).toHaveLength(0);
    expect(res.results.map((r) => r.provider)).toEqual(['khronos']);
    expect(res.providers.map((p) => [p.id, p.status, p.message])).toEqual([
      ['khronos', 'ok', null],
      ['polyhaven', 'disabled', 'not in STORE_PROVIDERS'],
    ]);
    expect(await codeOf(store.search({ providers: ['nope'] }))).toBe('INVALID_PARAMS');
  });

  it('refuses unknown categories and cursors of another search', async () => {
    const store = await storeWith({ builtin: fakeProvider('builtin', ['A', 'B', 'C']) });
    expect(await codeOf(store.search({ category: 'spaceships' as never }))).toBe('INVALID_PARAMS');
    const first = await store.search({ limit: 1 });
    expect(await codeOf(store.search({ query: 'other', cursor: first.next_cursor! }))).toBe('INVALID_PARAMS');
    expect(await codeOf(store.search({ cursor: 'garbage' }))).toBe('INVALID_PARAMS');
  });

  it('passes words, category and limit to the providers', async () => {
    const builtin = fakeProvider('builtin', ['Chair']);
    const store = await storeWith({ builtin });
    await store.search({ query: '  Wooden   Chairs ', category: 'furniture', limit: 3 });
    expect(builtin.queries[0]).toMatchObject({
      text: 'Wooden   Chairs',
      category: 'furniture',
      offset: 0,
      limit: 3,
    });
    expect(builtin.queries[0].words).toContain('wooden');
  });

  it('stops when the caller goes away', async () => {
    const store = await storeWith({
      khronos: fakeProvider('khronos', [], { search: () => new Promise<ProviderPage>(() => undefined) }),
    });
    const abort = new AbortController();
    const p = store.search({}, { signal: abort.signal });
    abort.abort();
    await expect(p).rejects.toBeInstanceOf(StoreCancelledError);
    // a cancelled search says nothing about the provider
    expect((await store.providers())[0]).toMatchObject({ status: 'ok', message: null });
  });

  it('answers UNAVAILABLE without a configuration (a store built for other tests)', async () => {
    const store = new ModelStore({} as ServiceContext);
    expect(await codeOf(store.search({}))).toBe('UNAVAILABLE');
    expect(await codeOf(store.providers())).toBe('UNAVAILABLE');
    await store.close();
  });
});
