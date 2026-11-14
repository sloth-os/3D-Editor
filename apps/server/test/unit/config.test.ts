import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, normalizeBasePath, parseHeaderList, publicDirCandidates } from '../../src/config';

const noFiles = { exists: () => false, cwd: '/srv/app', moduleDir: '/srv/app/apps/server/dist' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({}, noFiles);
    expect(c.port).toBe(8080);
    expect(c.host).toBe('0.0.0.0');
    expect(c.dataDir).toBe(path.resolve('/srv/app', 'data'));
    expect(c.persistence).toBe('memory');
    expect(c.roomIdleTtlSeconds).toBe(3600);
    expect(c.persistDebounceMs).toBe(1500);
    expect(c.shutdownTimeoutMs).toBe(9000);
    expect(c.shutdownSaveWaitMs).toBe(7000);
    expect(c.webdav).toBeNull();
    expect(c.webdavProxy).toBe(false);
    expect(c.authToken).toBeNull();
    expect(c.mcpEnabled).toBe(true);
    expect(c.mcpToken).toBeNull();
    expect(c.telemetryEnabled).toBe(true);
    expect(c.otel).toBeNull();
    expect(c.logLevel).toBe('info');
    expect(c.corsOrigins).toEqual([]);
    expect(c.publicDir).toBeNull();
    expect(c.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('parses numbers, booleans and lists', () => {
    const c = loadConfig(
      {
        PORT: '9000',
        HOST: '127.0.0.1',
        ROOM_IDLE_TTL_SECONDS: '60',
        PERSIST_DEBOUNCE_MS: '0',
        SHUTDOWN_TIMEOUT_SECONDS: '29.5',
        MCP_ENABLED: 'false',
        TELEMETRY_ENABLED: 'no',
        LOG_LEVEL: 'DEBUG',
        CORS_ORIGINS: 'https://a.example, https://b.example/ ,',
        AUTH_TOKEN: 'secret',
        MCP_TOKEN: 'agent',
        APP_VERSION: '1.2.3',
      },
      noFiles,
    );
    expect(c.port).toBe(9000);
    expect(c.host).toBe('127.0.0.1');
    expect(c.roomIdleTtlSeconds).toBe(60);
    expect(c.persistDebounceMs).toBe(0);
    expect(c.shutdownTimeoutMs).toBe(29_500);
    expect(c.shutdownSaveWaitMs).toBe(27_500);
    expect(c.mcpEnabled).toBe(false);
    expect(c.telemetryEnabled).toBe(false);
    expect(c.logLevel).toBe('debug');
    expect(c.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(c.authToken).toBe('secret');
    expect(c.mcpToken).toBe('agent');
    expect(c.version).toBe('1.2.3');
  });

  it('treats empty values as unset', () => {
    const c = loadConfig({ PORT: '', AUTH_TOKEN: '  ', WEBDAV_URL: '' }, noFiles);
    expect(c.port).toBe(8080);
    expect(c.authToken).toBeNull();
    expect(c.webdav).toBeNull();
  });

  it('defaults to WebDAV persistence and proxy when WEBDAV_URL is set', () => {
    const c = loadConfig(
      {
        WEBDAV_URL: 'https://dav.example.com/remote.php/dav/files/me/',
        WEBDAV_USERNAME: 'me',
        WEBDAV_PASSWORD: 'pw',
      },
      noFiles,
    );
    expect(c.persistence).toBe('webdav');
    expect(c.webdavProxy).toBe(true);
    expect(c.webdav).toEqual({
      url: 'https://dav.example.com/remote.php/dav/files/me',
      username: 'me',
      password: 'pw',
      basePath: '/3d-editor',
    });
  });

  it('persists to disk when DATA_DIR is given without SYNC_PERSISTENCE (phase-3 #22)', () => {
    const c = loadConfig({ DATA_DIR: '/tmp/projects' }, noFiles);
    expect(c.persistence).toBe('disk');
    expect(c.dataDir).toBe(path.resolve('/tmp/projects'));
    // an explicit mode wins, WebDAV wins over the data directory, and nothing means memory
    expect(loadConfig({ DATA_DIR: '/tmp/p', SYNC_PERSISTENCE: 'memory' }, noFiles).persistence).toBe(
      'memory',
    );
    expect(loadConfig({ DATA_DIR: '/tmp/p', WEBDAV_URL: 'http://dav.local' }, noFiles).persistence).toBe(
      'webdav',
    );
    expect(loadConfig({ DATA_DIR: '  ' }, noFiles).persistence).toBe('memory');
  });

  it('allows overriding persistence and disabling the proxy', () => {
    const c = loadConfig(
      {
        WEBDAV_URL: 'http://dav.local',
        SYNC_PERSISTENCE: 'disk',
        WEBDAV_PROXY: '0',
        WEBDAV_BASE_PATH: 'editor/data/',
      },
      noFiles,
    );
    expect(c.persistence).toBe('disk');
    expect(c.webdavProxy).toBe(false);
    expect(c.webdav?.basePath).toBe('/editor/data');
  });

  it('configures OpenTelemetry only with an endpoint', () => {
    const c = loadConfig(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/',
        OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=abc%20def,foo=bar',
      },
      noFiles,
    );
    expect(c.otel).toEqual({
      endpoint: 'http://collector:4318',
      serviceName: '3d-editor-server',
      headers: { 'x-api-key': 'abc def', foo: 'bar' },
    });
  });

  it('rejects invalid values with a readable message', () => {
    expect(() => loadConfig({ PORT: 'abc' }, noFiles)).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '70000' }, noFiles)).toThrow(/PORT/);
    expect(() => loadConfig({ MCP_ENABLED: 'maybe' }, noFiles)).toThrow(/MCP_ENABLED/);
    expect(() => loadConfig({ SYNC_PERSISTENCE: 'cloud' }, noFiles)).toThrow(/SYNC_PERSISTENCE/);
    expect(() => loadConfig({ SYNC_PERSISTENCE: 'webdav' }, noFiles)).toThrow(/WEBDAV_URL/);
    expect(() => loadConfig({ WEBDAV_URL: 'ftp://x' }, noFiles)).toThrow(/WEBDAV_URL/);
    expect(() => loadConfig({ LOG_LEVEL: 'loud' }, noFiles)).toThrow(/LOG_LEVEL/);
    expect(() => loadConfig({ SHUTDOWN_TIMEOUT_SECONDS: '0' }, noFiles)).toThrow(/SHUTDOWN_TIMEOUT_SECONDS/);
  });

  it('applies the defaults of video export, the model store and the rideo bridge', () => {
    const c = loadConfig({}, noFiles);
    expect(c.ffmpegPath).toBe('ffmpeg');
    expect(c.exportDir).toBe(path.resolve('/srv/app', 'data', 'exports'));
    expect(c.exportMaxBytes).toBe(20480 * 1024 * 1024);
    expect(c.exportTtlMs).toBe(168 * 3_600_000);
    expect(c.exportMaxQueued).toBe(8);
    expect(c.storeProviders).toEqual(['builtin', 'khronos', 'polyhaven', 'sketchfab', 'polypizza']);
    expect(c.sketchfabToken).toBeNull();
    expect(c.polypizzaApiKey).toBeNull();
    expect(c.storeCatalogUrls).toEqual([]);
    expect(c.modelCacheDir).toBe(path.resolve('/srv/app', 'data', 'model-cache'));
    expect(c.modelCacheMaxBytes).toBe(2048 * 1024 * 1024);
    expect(c.storeFetchTimeoutMs).toBe(20_000);
    expect(c.rideoUrl).toBeNull();
    expect(c.rideoToken).toBeNull();
    // the export and cache folders follow DATA_DIR
    const d = loadConfig({ DATA_DIR: '/var/lib/editor' }, noFiles);
    expect(d.exportDir).toBe(path.resolve('/var/lib/editor', 'exports'));
    expect(d.modelCacheDir).toBe(path.resolve('/var/lib/editor', 'model-cache'));
  });

  it('parses the settings of video export, the model store and the rideo bridge', () => {
    const c = loadConfig(
      {
        FFMPEG_PATH: 'bin/ffmpeg',
        EXPORT_DIR: 'out/videos',
        EXPORT_MAX_MB: '512',
        EXPORT_TTL_HOURS: '1.5',
        EXPORT_MAX_QUEUED: '2',
        STORE_PROVIDERS: 'PolyHaven, builtin,polyhaven ,catalog',
        SKETCHFAB_TOKEN: 'sk',
        POLYPIZZA_API_KEY: 'pp',
        STORE_CATALOG_URLS: 'https://a.example/catalog.json, http://b.example/models.json',
        MODEL_CACHE_DIR: '/cache/models',
        MODEL_CACHE_MAX_MB: '0',
        STORE_FETCH_TIMEOUT_MS: '5000',
        RIDEO_URL: 'https://rideo.example/api/',
        RIDEO_TOKEN: 'rt',
      },
      noFiles,
    );
    // a path with a slash is a file (made absolute); a bare name is looked up on the PATH
    expect(c.ffmpegPath).toBe(path.resolve('/srv/app', 'bin/ffmpeg'));
    expect(loadConfig({ FFMPEG_PATH: 'ffmpeg6' }, noFiles).ffmpegPath).toBe('ffmpeg6');
    expect(c.exportDir).toBe(path.resolve('/srv/app', 'out/videos'));
    expect(c.exportMaxBytes).toBe(512 * 1024 * 1024);
    expect(c.exportTtlMs).toBe(5_400_000);
    expect(c.exportMaxQueued).toBe(2);
    // known ids in the given order, each once, letter case ignored
    expect(c.storeProviders).toEqual(['polyhaven', 'builtin', 'catalog']);
    expect(c.sketchfabToken).toBe('sk');
    expect(c.polypizzaApiKey).toBe('pp');
    expect(c.storeCatalogUrls).toEqual(['https://a.example/catalog.json', 'http://b.example/models.json']);
    expect(c.modelCacheDir).toBe('/cache/models');
    expect(c.modelCacheMaxBytes).toBe(0);
    expect(c.storeFetchTimeoutMs).toBe(5000);
    expect(c.rideoUrl).toBe('https://rideo.example/api');
    expect(c.rideoToken).toBe('rt');
    // catalog URLs without STORE_PROVIDERS add the catalog provider to the defaults
    expect(loadConfig({ STORE_CATALOG_URLS: 'https://a.example/c.json' }, noFiles).storeProviders).toEqual([
      'builtin',
      'khronos',
      'polyhaven',
      'sketchfab',
      'polypizza',
      'catalog',
    ]);
  });

  it('rejects invalid settings of video export, the model store and the rideo bridge', () => {
    expect(() => loadConfig({ EXPORT_MAX_MB: '0' }, noFiles)).toThrow(/EXPORT_MAX_MB/);
    expect(() => loadConfig({ EXPORT_TTL_HOURS: '-1' }, noFiles)).toThrow(/EXPORT_TTL_HOURS/);
    expect(() => loadConfig({ EXPORT_MAX_QUEUED: '1.5' }, noFiles)).toThrow(/EXPORT_MAX_QUEUED/);
    expect(() => loadConfig({ MODEL_CACHE_MAX_MB: '-5' }, noFiles)).toThrow(/MODEL_CACHE_MAX_MB/);
    expect(() => loadConfig({ STORE_FETCH_TIMEOUT_MS: '50' }, noFiles)).toThrow(/STORE_FETCH_TIMEOUT_MS/);
    expect(() => loadConfig({ STORE_FETCH_TIMEOUT_MS: '600001' }, noFiles)).toThrow(/STORE_FETCH_TIMEOUT_MS/);
    expect(() => loadConfig({ RIDEO_URL: 'ftp://rideo' }, noFiles)).toThrow(/RIDEO_URL/);
    expect(() => loadConfig({ STORE_PROVIDERS: 'builtin,turbosquid' }, noFiles)).toThrow(
      /STORE_PROVIDERS: unknown provider 'turbosquid' \(known: builtin, khronos, polyhaven, sketchfab, polypizza, catalog\)/,
    );
    expect(() => loadConfig({ STORE_PROVIDERS: 'builtin,catalog' }, noFiles)).toThrow(/STORE_CATALOG_URLS/);
    expect(() => loadConfig({ STORE_CATALOG_URLS: 'https://a.example/c.json,file:///etc' }, noFiles)).toThrow(
      /STORE_CATALOG_URLS/,
    );
  });

  it('finds the public directory next to the bundle, then apps/web/dist', () => {
    const moduleDir = '/app/dist';
    const cands = publicDirCandidates(moduleDir, '/repo');
    expect(cands[0]).toBe(path.resolve('/app/public'));
    expect(cands[1]).toBe(path.resolve('/repo/apps/web/dist'));
    const docker = loadConfig(
      {},
      { moduleDir, cwd: '/', exists: (p) => p === path.join('/app/public', 'index.html') },
    );
    expect(docker.publicDir).toBe(path.resolve('/app/public'));
    const repo = loadConfig(
      {},
      {
        moduleDir: '/repo/apps/server/dist',
        cwd: '/repo',
        exists: (p) => p.startsWith('/repo/apps/web/dist'),
      },
    );
    expect(repo.publicDir).toBe(path.resolve('/repo/apps/web/dist'));
    const explicit = loadConfig({ PUBLIC_DIR: './www' }, { ...noFiles, cwd: '/x' });
    expect(explicit.publicDir).toBe(path.resolve('/x/www'));
  });
});

describe('helpers', () => {
  it('normalizes base paths', () => {
    expect(normalizeBasePath('/3d-editor/')).toBe('/3d-editor');
    expect(normalizeBasePath('a//b/./c')).toBe('/a/b/c');
    expect(normalizeBasePath('/')).toBe('');
    expect(() => normalizeBasePath('/a/../b')).toThrow();
  });

  it('parses OTLP header lists', () => {
    expect(parseHeaderList('a=1, b = two ,broken,=x')).toEqual({ a: '1', b: 'two' });
    expect(parseHeaderList(undefined)).toEqual({});
  });
});
