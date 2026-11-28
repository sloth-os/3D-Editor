import { prefs } from './prefs';
import { pageUrl, serverBaseUrl, serverRouteUrl } from './base-url';

/** Shape of `GET /api/config` returned by the editor server. */
export interface ServerConfig {
  version: string;
  features: {
    sync: boolean;
    mcp: boolean;
    telemetry: boolean;
    webdavProxy: boolean;
    /**
     * The server's own video export (it found ffmpeg); absent on older servers. The Export Video
     * window exports on this device by default (apps/web/src/export) and offers the server as a
     * second choice only where this is true and the server holds the project.
     */
    videoExport?: boolean;
    /** The model store (Asset Browser); absent on older servers. */
    modelStore?: boolean;
  };
  /** The server's WebDAV proxy: `url` is its route as a path from the server's root ('/dav'). */
  webdav: { url: string; basePath: string } | null;
  persistence: string;
}

/**
 * The URL the editor server's routes are under, with its trailing slash (base-url.ts
 * serverBaseUrl): the Server URL preference when it is set, with its path, else the app's base
 * ('https://example.com/3d/' for the editor behind a proxy at /3d/).
 */
export function serverBase(): string {
  return serverBaseUrl(prefs.value.sync.serverUrl);
}

/**
 * The URL of a server route given as a path from the server's root ('/api/projects', '/dav', a REST
 * answer's '/api/…' path), as the page asks for it (base-url.ts serverRouteUrl and pageUrl): a
 * path on the page's own origin ('/3d/api/projects'), an absolute URL under a Server URL elsewhere.
 */
export function serverRoute(path: string): string {
  return pageUrl(serverRouteUrl(path, serverBase()));
}

/**
 * serverRoute with the access token as `?token=` (for URLs the browser loads itself, such as images,
 * links and videos; requests also send it as a header, authHeaders).
 */
export function apiUrl(path: string): string {
  const url = serverRoute(path);
  const token = prefs.value.sync.token;
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

export function authHeaders(): Record<string, string> {
  const token = prefs.value.sync.token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Fetches the server configuration; null when no editor server is reachable (offline/static hosting). */
export async function fetchServerConfig(timeoutMs = 3500): Promise<ServerConfig | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl('/api/config'), {
      signal: ctrl.signal,
      headers: authHeaders(),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = (await res.json()) as ServerConfig;
    return json && typeof json === 'object' && json.features ? json : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * The WebSocket URL of a server route given as a path from the server's root ('/sync/<project>'):
 * under the server's base like serverRoute, with the path of a Server URL kept
 * ('wss://example.com/3d/sync/<project>'), ws: for http: and wss: for https:, and the token as
 * `?token=`.
 */
export function wsUrl(path: string): string {
  const u = serverRouteUrl(path, serverBase());
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = prefs.value.sync.token;
  if (token) u.searchParams.set('token', token);
  return u.toString();
}
