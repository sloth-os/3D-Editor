import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { ServerConfig } from './config';

/** Areas of the server protected by the shared secret(s). */
export type AuthScope = 'api' | 'sync' | 'mcp' | 'dav' | 'otlp';

const SCOPES: AuthScope[] = ['api', 'sync', 'mcp', 'dav', 'otlp'];

/** Returns the protected scope a request path belongs to, or null for public paths. */
export function scopeForPath(pathname: string): AuthScope | null {
  for (const s of SCOPES) {
    const prefix = `/${s}`;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return s;
  }
  return null;
}

/** Tokens accepted for a scope; an empty list means the scope is open. */
export function acceptedTokens(
  config: Pick<ServerConfig, 'authToken' | 'mcpToken'>,
  scope: AuthScope,
): string[] {
  const out: string[] = [];
  if (config.authToken) out.push(config.authToken);
  if (scope === 'mcp' && config.mcpToken) out.push(config.mcpToken);
  return out;
}

/** Extracts a credential from `Authorization: Bearer <t>` or the `token` query parameter. */
export function extractToken(headers: IncomingHttpHeaders, rawUrl: string | undefined): string | null {
  const auth = headers.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  if (rawUrl) {
    const q = rawUrl.indexOf('?');
    if (q >= 0) {
      const token = new URLSearchParams(rawUrl.slice(q + 1)).get('token');
      if (token) return token;
    }
  }
  return null;
}

/** Constant-time string comparison (hashing first equalizes lengths). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export function pathnameOf(rawUrl: string | undefined): string {
  if (!rawUrl) return '/';
  const q = rawUrl.indexOf('?');
  return q >= 0 ? rawUrl.slice(0, q) : rawUrl;
}

/**
 * Checks whether a request may access `pathname`. Public paths (static files, health,
 * metrics) are always allowed.
 */
export function isAuthorized(
  config: Pick<ServerConfig, 'authToken' | 'mcpToken'>,
  pathname: string,
  headers: IncomingHttpHeaders,
  rawUrl: string | undefined,
): boolean {
  const scope = scopeForPath(pathname);
  if (!scope) return true;
  const tokens = acceptedTokens(config, scope);
  if (tokens.length === 0) return true;
  const provided = extractToken(headers, rawUrl);
  if (!provided) return false;
  let ok = false;
  // Compare against every accepted token (no early exit) to keep timing uniform.
  for (const t of tokens) if (safeEqual(provided, t)) ok = true;
  return ok;
}

/** Removes the `token` query parameter from a URL before it is logged. */
export function redactUrl(rawUrl: string): string {
  return rawUrl.replace(/([?&]token=)[^&#]*/gi, '$1[REDACTED]');
}
