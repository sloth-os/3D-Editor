import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoreResult } from '@3d-editor/core';
import {
  AssetSearch,
  LOCAL_BUILTIN_STATUS,
  SEARCH_DEBOUNCE_MS,
  localBackend,
  sameQuery,
  serverBackend,
  type AssetQuery,
  type SearchBackend,
  type SearchPage,
} from '../src/ui/assets/search';
import { ApiError, type StoreProviderStatus } from '../src/io/store-client';

/*
 * The Asset Browser's search: typed searches wait for a pause (debounce), pages follow the cursor
 * (each model once), a newer search drops the answers of older ones, failures can be retried, and
 * provider states merge from every page. Without a server the built-in catalog of core is searched
 * in the browser (an offset cursor).
 */

const model = (id: string, provider = 'builtin'): StoreResult => ({
  id,
  provider,
  name: id.split(':')[1] ?? id,
  category: null,
  tags: [],
  thumbnail_url: null,
  license: { spdx: 'CC0-1.0', url: null, attribution: null },
  author: null,
  source_url: null,
  dimensions_m: null,
  triangles: null,
  formats: ['builtin'],
  downloadable: true,
});

const q = (text: string, extra: Partial<AssetQuery> = {}): AssetQuery => ({
  text,
  category: null,
  provider: 'all',
  ...extra,
});

/** A backend whose pages the test answers by hand. */
function manualBackend() {
  const calls: { q: AssetQuery; cursor: string | null; signal: AbortSignal }[] = [];
  const pending: { resolve: (p: SearchPage) => void; reject: (e: unknown) => void }[] = [];
  const backend: SearchBackend = {
    kind: 'server',
    providers: async () => [{ ...LOCAL_BUILTIN_STATUS, id: 'khronos', name: 'Khronos', message: null }],
    page: (query, cursor, signal) =>
      new Promise<SearchPage>((resolve, reject) => {
        calls.push({ q: query, cursor, signal });
        pending.push({ resolve, reject });
      }),
  };
  return { backend, calls, pending };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AssetSearch', () => {
  it('searches typed words after a pause, once, with the last words', () => {
    vi.useFakeTimers();
    const { backend, calls } = manualBackend();
    const s = new AssetSearch(backend);
    s.request(q('c'));
    vi.advanceTimersByTime(100);
    s.request(q('ch'));
    vi.advanceTimersByTime(100);
    s.request(q('chair'));
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(calls.map((c) => c.q.text)).toEqual(['chair']);
    // Enter (immediate) does not wait; asking for what is shown does nothing unless forced
    s.request(q('table'), { immediate: true });
    expect(calls).toHaveLength(2);
    s.request(q(' table '), { immediate: true });
    expect(calls).toHaveLength(2);
    s.request(q('table'), { immediate: true, force: true });
    expect(calls).toHaveLength(3);
    s.dispose();
  });

  it('pages on with the cursor, each model once, and stops at the end', async () => {
    const { backend, calls, pending } = manualBackend();
    const s = new AssetSearch(backend);
    const first = s.run(q('chair'));
    expect(s.loading.value).toBe(true);
    pending[0].resolve({ results: [model('builtin:chair'), model('builtin:stool')], next: 'c1' });
    await first;
    expect(s.results.value.map((r) => r.id)).toEqual(['builtin:chair', 'builtin:stool']);
    expect(s.next.value).toBe('c1');
    expect(s.loading.value).toBe(false);

    const second = s.more();
    // another call while a page loads does nothing
    void s.more();
    expect(calls.map((c) => c.cursor)).toEqual([null, 'c1']);
    pending[1].resolve({ results: [model('builtin:stool'), model('khronos:Chair', 'khronos')], next: null });
    await second;
    expect(s.results.value.map((r) => r.id)).toEqual(['builtin:chair', 'builtin:stool', 'khronos:Chair']);
    expect(s.next.value).toBeNull();
    await s.more();
    expect(calls).toHaveLength(2);
  });

  it('drops the answers of an older search', async () => {
    const { backend, calls, pending } = manualBackend();
    const s = new AssetSearch(backend);
    const older = s.run(q('chair'));
    const newer = s.run(q('table'));
    expect(calls[0].signal.aborted).toBe(true);
    pending[1].resolve({ results: [model('builtin:table')], next: null });
    await newer;
    pending[0].resolve({ results: [model('builtin:chair')], next: 'x' });
    await older;
    expect(s.query.value?.text).toBe('table');
    expect(s.results.value.map((r) => r.id)).toEqual(['builtin:table']);
    expect(s.next.value).toBeNull();
    expect(s.loading.value).toBe(false);
  });

  it('shows a failure, keeps the results so far and asks again for the failed page', async () => {
    const { backend, calls, pending } = manualBackend();
    const s = new AssetSearch(backend);
    const first = s.run(q('lamp'));
    pending[0].resolve({ results: [model('builtin:lamp')], next: 'c1' });
    await first;
    const more = s.more();
    pending[1].reject(new ApiError('Model store unavailable', 503, 'UNAVAILABLE'));
    await more;
    expect(s.error.value).toBe('Model store unavailable');
    expect(s.results.value).toHaveLength(1);
    // no more pages while failed, until retried
    await s.more();
    expect(calls).toHaveLength(2);
    const retry = s.retry();
    expect(s.error.value).toBeNull();
    expect(calls[2].cursor).toBe('c1');
    pending[2].resolve({ results: [model('builtin:floor_lamp')], next: null });
    await retry;
    expect(s.results.value.map((r) => r.id)).toEqual(['builtin:lamp', 'builtin:floor_lamp']);

    // a failed first page: retry runs the search again
    const again = s.run(q('x'));
    pending[3].reject(new Error('offline'));
    await again;
    expect(s.error.value).toBe('offline');
    const r2 = s.retry();
    expect(calls[4]).toMatchObject({ cursor: null, q: { text: 'x' } });
    pending[4].resolve({ results: [], next: null });
    await r2;
    expect(s.error.value).toBeNull();
  });

  it('merges the provider states each page reports', async () => {
    const { backend, pending } = manualBackend();
    const s = new AssetSearch(backend);
    await s.loadProviders();
    expect(s.statuses.value.map((p) => p.id)).toEqual(['khronos']);
    const run = s.run(q('car'));
    const sketchfab: StoreProviderStatus = {
      id: 'sketchfab',
      name: 'Sketchfab',
      enabled: true,
      status: 'timeout',
      needs_key: null,
      message: 'no answer within 5 s',
    };
    pending[0].resolve({
      results: [],
      next: null,
      providers: [{ ...s.statuses.value[0], status: 'error', message: 'HTTP 500' }, sketchfab],
    });
    await run;
    expect(s.statuses.value.map((p) => `${p.id}:${p.status}`)).toEqual([
      'khronos:error',
      'sketchfab:timeout',
    ]);
  });

  it('stops everything on dispose', async () => {
    vi.useFakeTimers();
    const { backend, calls } = manualBackend();
    const s = new AssetSearch(backend);
    s.request(q('x'));
    s.dispose();
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
    expect(calls).toHaveLength(0);
    void s.run(q('y'));
    s.dispose();
    expect(calls[0].signal.aborted).toBe(true);
    expect(s.loading.value).toBe(false);
  });

  it('compares queries by their trimmed words, category and provider', () => {
    expect(sameQuery(q(' a '), q('a'))).toBe(true);
    expect(sameQuery(q('a'), q('a', { category: 'food' }))).toBe(false);
    expect(sameQuery(q('a'), q('a', { provider: 'builtin' }))).toBe(false);
    expect(sameQuery(null, q('a'))).toBe(false);
  });
});

describe('search backends', () => {
  it('searches the built-in catalog in the browser, paging by offset', async () => {
    const b = localBackend(2);
    const signal = new AbortController().signal;
    expect(await b.providers(signal)).toEqual([LOCAL_BUILTIN_STATUS]);
    const p1 = await b.page(q('chair'), null, signal);
    expect(p1.results).toHaveLength(2);
    expect(p1.results.every((r) => r.provider === 'builtin' && r.thumbnail_url === null)).toBe(true);
    expect(p1.results[0].id).toBe('builtin:chair');
    expect(p1.next).toBe('2');
    const p2 = await b.page(q('chair'), p1.next, signal);
    expect(p2.results.map((r) => r.id)).not.toContain(p1.results[0].id);
    // a category narrows, another provider finds nothing here
    const food = await localBackend(50).page(q('', { category: 'food' }), null, signal);
    expect(food.results.length).toBeGreaterThan(3);
    expect(food.results.every((r) => r.category === 'food')).toBe(true);
    expect(food.next).toBeNull();
    expect((await b.page(q('chair', { provider: 'khronos' }), null, signal)).results).toEqual([]);
  });

  it('asks the server for one provider, or every one', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [], providers: [], next_cursor: 'n' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const b = serverBackend(12);
      const signal = new AbortController().signal;
      const page = await b.page(q('car', { provider: 'khronos', category: 'vehicles' }), 'c0', signal);
      expect(page.next).toBe('n');
      await b.page(q('car'), null, signal);
      const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
      expect(urls[0]).toBe(
        '/api/store/search?query=car&category=vehicles&providers=khronos&limit=12&cursor=c0',
      );
      expect(urls[1]).toBe('/api/store/search?query=car&limit=12');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
