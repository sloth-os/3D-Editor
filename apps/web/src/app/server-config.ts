import { prefs } from './prefs';

/** Shape of `GET /api/config` returned by the editor server. */
export interface ServerConfig {
  version: string;
  features: { sync: boolean; mcp: boolean; telemetry: boolean; webdavProxy: boolean };
  webdav: { url: string; basePath: string } | null;
  persistence: string;
}

/** Base origin of the editor server (empty string = same origin). */
export function serverBase(): string {
  return prefs.value.sync.serverUrl.replace(/\/$/, '');
}

export function apiUrl(path: string): string {
  const base = serverBase();
  const token = prefs.value.sync.token;
  const url = `${base}${path}`;
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
    const res = await fetch(apiUrl('/api/config'), { signal: ctrl.signal, headers: authHeaders(), cache: 'no-store' });
    if (!res.ok) return null;
    const json = (await res.json()) as ServerConfig;
    return json && typeof json === 'object' && json.features ? json : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export function wsUrl(path: string): string {
  const base = serverBase() || location.origin;
  const u = new URL(path, base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = prefs.value.sync.token;
  if (token) u.searchParams.set('token', token);
  return u.toString();
}
