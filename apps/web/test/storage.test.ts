import { describe, expect, it } from 'vitest';
import { resolveWebDAV } from '../src/storage/webdav';
import { prefs, defaultPreferences } from '../src/app/prefs';
import { serverConfig } from '../src/app/store';
import { localIndex } from '../src/project/local-index';

describe('storage selection', () => {
  it('uses the browser only when nothing is configured', () => {
    prefs.value = defaultPreferences();
    serverConfig.value = null;
    expect(resolveWebDAV()).toBeNull();
  });

  it('prefers the server WebDAV proxy in auto mode', () => {
    prefs.value = defaultPreferences();
    serverConfig.value = {
      version: '1',
      features: { sync: true, mcp: true, telemetry: true, webdavProxy: true },
      webdav: { url: '/dav', basePath: '/3d-editor' },
      persistence: 'webdav',
    };
    const t = resolveWebDAV()!;
    expect(t.viaServer).toBe(true);
    expect(t.store.basePath).toBe('/3d-editor');
  });

  it('uses a custom WebDAV server when configured, and nothing in browser mode', () => {
    const p = defaultPreferences();
    p.storage.mode = 'webdav';
    p.storage.webdav = {
      url: 'https://dav.example.com/files/me',
      username: 'u',
      password: 'p',
      basePath: '/proj',
    };
    prefs.value = p;
    serverConfig.value = null;
    const t = resolveWebDAV()!;
    expect(t.viaServer).toBe(false);
    expect(t.label).toContain('dav.example.com');
    prefs.value = { ...p, storage: { ...p.storage, mode: 'browser' } };
    expect(resolveWebDAV()).toBeNull();
  });
});

describe('local project index (IndexedDB)', () => {
  it('stores, lists and removes entries', async () => {
    await localIndex.put({
      id: 'a',
      name: 'A',
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      schema_version: 1,
    });
    await localIndex.put({
      id: 'b',
      name: 'B',
      created_at: '2026-01-01',
      updated_at: '2026-01-03',
      schema_version: 1,
    });
    const list = await localIndex.list();
    expect(list.map((p) => p.id)).toEqual(['b', 'a']);
    await localIndex.patch('a', { name: 'A2' });
    expect((await localIndex.get('a'))?.name).toBe('A2');
    await localIndex.remove('a');
    expect((await localIndex.list()).map((p) => p.id)).toEqual(['b']);
  });
});
