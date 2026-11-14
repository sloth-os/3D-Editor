import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updatePrefs } from '../src/app/prefs';
import {
  ApiError,
  deleteVideoExport,
  downloadStoreFile,
  exportFinished,
  fetchStoreModel,
  fetchStoreProviders,
  getVideoExport,
  isAbort,
  listVideoExports,
  searchStore,
  startVideoExport,
  storeFilePath,
  storeModelPath,
  storeSearchParams,
  storeThumbnailUrl,
  videoExportFileUrl,
} from '../src/io/store-client';

/*
 * The typed client of the server's model store and video export routes: paths and query strings,
 * the token (header for requests, ?token= for URLs the browser loads), error bodies as ApiError
 * with the server's code, and streamed downloads with progress.
 */

/** A minimal fetch Response with a JSON body. */
function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function setToken(token: string): void {
  updatePrefs((p) => ({ ...p, sync: { ...p.sync, serverUrl: '', token } }));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  setToken('');
});
afterEach(() => {
  vi.unstubAllGlobals();
  setToken('');
});

describe('model store client', () => {
  it('keeps the colon of store ids in paths and encodes everything else', () => {
    expect(storeModelPath('khronos:SheenChair')).toBe('/api/store/models/khronos:SheenChair');
    expect(storeModelPath('catalog:a b/c?d')).toBe('/api/store/models/catalog:a%20b%2Fc%3Fd');
    expect(storeFilePath('polyhaven:chair', 'textures/wood diffuse.png')).toBe(
      '/api/store/models/polyhaven:chair/files/textures/wood%20diffuse.png',
    );
    // '' is the main file; empty segments go
    expect(storeFilePath('khronos:Box', '')).toBe('/api/store/models/khronos:Box/files/');
    expect(storeFilePath('khronos:Box', 'a//b.bin')).toBe('/api/store/models/khronos:Box/files/a/b.bin');
  });

  it('writes the search query string without empty fields', () => {
    expect(storeSearchParams({ query: '  red chair ', category: null }).toString()).toBe('query=red+chair');
    expect(
      storeSearchParams({
        query: '',
        category: 'furniture',
        providers: ['builtin', 'khronos'],
        limit: 99,
        cursor: 'abc',
      }).toString(),
    ).toBe('category=furniture&providers=builtin%2Ckhronos&limit=50&cursor=abc');
    expect(storeSearchParams({ limit: 0 }).get('limit')).toBe('1');
  });

  it('searches with the token as a Bearer header and normalizes the page', async () => {
    setToken('s3cret');
    fetchMock.mockResolvedValueOnce(
      json({
        results: [{ id: 'builtin:chair', name: 'Chair' }],
        providers: [{ id: 'builtin', status: 'ok' }],
        next_cursor: '',
      }),
    );
    const page = await searchStore({ query: 'chair', providers: ['builtin'], limit: 24 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/store/search?query=chair&providers=builtin&limit=24&token=s3cret');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer s3cret');
    expect(page.results.map((r) => r.id)).toEqual(['builtin:chair']);
    expect(page.next_cursor).toBeNull();
    // a body without arrays still gives a page
    fetchMock.mockResolvedValueOnce(json({}));
    expect(await searchStore({})).toEqual({ results: [], providers: [], next_cursor: null });
  });

  it('throws ApiError with the server message, status and code', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: 'Downloading Poly Pizza models needs POLYPIZZA_API_KEY', code: 'NEEDS_KEY' }, 400),
    );
    const err = await fetchStoreModel('polypizza:x', { download: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'NEEDS_KEY' });
    expect((err as ApiError).message).toContain('POLYPIZZA_API_KEY');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/store/models/polypizza:x?download=1');

    // a body that is not JSON: the status line
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('not json');
      },
    } as unknown as Response);
    const bad = await fetchStoreProviders().catch((e: unknown) => e);
    expect(bad).toMatchObject({ status: 502, code: null });
    expect((bad as Error).message).toMatch(/HTTP 502/);

    // no answer at all
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const off = await fetchStoreProviders().catch((e: unknown) => e);
    expect(off).toMatchObject({ status: 0, code: null });
  });

  it('rethrows aborts as they are', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    fetchMock.mockRejectedValueOnce(abort);
    const err = await searchStore({ query: 'x' }).catch((e: unknown) => e);
    expect(err).toBe(abort);
    expect(isAbort(err)).toBe(true);
    expect(isAbort(new Error('x'))).toBe(false);
  });

  it('builds thumbnail URLs with the token, none for models without a thumbnail', () => {
    setToken('tk');
    expect(storeThumbnailUrl({ id: 'builtin:chair', thumbnail_url: null })).toBeNull();
    expect(
      storeThumbnailUrl({ id: 'builtin:chair', thumbnail_url: '/api/store/models/builtin:chair/thumbnail' }),
    ).toBe('/api/store/models/builtin:chair/thumbnail?token=tk');
    expect(storeThumbnailUrl({ id: 'x:y', thumbnail_url: 'https://cdn.example/t.png' })).toBe(
      'https://cdn.example/t.png',
    );
    // a relative form the server did not write: the store's route
    expect(storeThumbnailUrl({ id: 'x:y', thumbnail_url: 'thumb' })).toBe(
      '/api/store/models/x:y/thumbnail?token=tk',
    );
  });

  it('downloads a file in chunks and reports the bytes received', async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])];
    let i = 0;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
        }),
      },
    } as unknown as Response);
    const seen: number[] = [];
    const data = await downloadStoreFile('khronos:Box', 'Box.glb', { onBytes: (n) => seen.push(n) });
    expect([...data]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(seen).toEqual([3, 7]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/store/models/khronos:Box/files/Box.glb');

    // without a stream (or a progress callback): the whole body
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: null,
      arrayBuffer: async () => new Uint8Array([9, 8]).buffer,
    } as unknown as Response);
    expect([...(await downloadStoreFile('khronos:Box', 'a.bin'))]).toEqual([9, 8]);

    fetchMock.mockResolvedValueOnce(json({ error: 'khronos:Box has no file', code: 'NOT_FOUND' }, 404));
    await expect(downloadStoreFile('khronos:Box', 'nope.bin')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('video export client', () => {
  it('starts an export with a JSON body and reads the 202 job', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'job1', status: 'queued' }, 202));
    const job = await startVideoExport('proj 1', { shots: 'all', quality: 'draft', width: 160, height: 90 });
    expect(job.id).toBe('job1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/projects/proj%201/video-exports');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({
      shots: 'all',
      quality: 'draft',
      width: 160,
      height: 90,
    });
  });

  it('lists, polls (wait clamped to 50 s) and deletes exports', async () => {
    fetchMock.mockResolvedValueOnce(json({ exports: [{ id: 'a' }, { id: 'b' }] }));
    expect((await listVideoExports('p')).map((j) => j.id)).toEqual(['a', 'b']);
    fetchMock.mockResolvedValueOnce(json({ id: 'a', status: 'running' }));
    await getVideoExport('p', 'a', { waitS: 80 });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/projects/p/video-exports/a?wait=50');
    fetchMock.mockResolvedValueOnce(json({ id: 'a', status: 'running' }));
    await getVideoExport('p', 'a');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/projects/p/video-exports/a');
    fetchMock.mockResolvedValueOnce(json({ id: 'a', status: 'cancelled' }));
    await deleteVideoExport('p', 'a');
    expect(fetchMock.mock.calls[3][1]?.method).toBe('DELETE');
    fetchMock.mockResolvedValueOnce(json({ error: 'all busy', code: 'QUEUE_FULL' }, 409));
    await expect(startVideoExport('p', {})).rejects.toMatchObject({ code: 'QUEUE_FULL', status: 409 });
  });

  it('links files with the token and knows which jobs ended', () => {
    setToken('tk');
    expect(videoExportFileUrl({ url: '/api/projects/p/video-exports/a/files/sequence.mp4' })).toBe(
      '/api/projects/p/video-exports/a/files/sequence.mp4?token=tk',
    );
    expect(['queued', 'running', 'encoding'].map((s) => exportFinished(s as never))).toEqual([
      false,
      false,
      false,
    ]);
    expect(['done', 'failed', 'cancelled'].map((s) => exportFinished(s as never))).toEqual([
      true,
      true,
      true,
    ]);
  });
});
