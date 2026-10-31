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
