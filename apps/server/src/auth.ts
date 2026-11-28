import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyRequest } from 'fastify';
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
 * The path a request's scope is read from (scopeForPath): the route that serves it, as Fastify
 * matched it (`/api/projects/:id`, `/mcp`; a wildcard route with what its `*` matched, as the router
 * decoded it: `/dav/x` for `/dav/*`, the whole path for the built files' `/*`), else, for a request
 * no route serves (the not-found handler), its path. The router reads an absolute-form target by its
 * path and decodes percent-encodings before it matches (`/%61pi/projects` is served by
 * `/api/projects`), so the scope is that of the handler that answers, whatever the spelling of the
 * request's path.
 */
export function routedPath(
  request: Pick<FastifyRequest, 'is404' | 'routeOptions' | 'params' | 'url'>,
): string {
  const route = request.is404 ? undefined : request.routeOptions.url;
  if (route === undefined) return pathnameOf(request.url);
  if (!route.endsWith('*')) return route;
  const params = request.params as Record<string, unknown> | undefined;
  const rest = params?.['*'];
  return `${route.slice(0, -1)}${typeof rest === 'string' ? rest : ''}`;
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

const QUESTION = 63;
const AMPERSAND = 38;
const EQUALS = 61;
const HASH = 35;
const TOKEN_NAME = 'token';
/** The longest spelling of a query name that decodes to `token`: each of its letters as `%HH`. */
const TOKEN_NAME_MAX = TOKEN_NAME.length * 3;
const REDACTED = '[REDACTED]';

/**
 * Whether a query name as sent decodes to `token`, in any letter case: `token`, `%74oken`,
 * `to%6Ben`, `TOKEN` (extractToken reads names as URLSearchParams decodes them). Only a name of at
 * most TOKEN_NAME_MAX characters can, so decoding it costs a bounded time; one that does not decode
 * (`%zz`) is not `token`, as URLSearchParams keeps such a `%` as it is.
 */
function isTokenName(name: string): boolean {
  if (name.length < TOKEN_NAME.length || name.length > TOKEN_NAME_MAX) return false;
  try {
    return decodeURIComponent(name).toLowerCase() === TOKEN_NAME;
  } catch {
    return false;
  }
}

/**
 * A URL as it is logged: the value of every query pair whose name decodes to `token` (isTokenName)
 * replaced by `[REDACTED]`, the rest as sent. A pair starts after any `?` or `&` from the query's
 * `?` on (so `??token=`, which URLSearchParams reads as `token`, is one) and its value ends at the
 * next `&` or `#`. Time linear in the URL's length: each `?` or `&` is followed by at most
 * TOKEN_NAME_MAX + 1 characters of name.
 */
export function redactUrl(rawUrl: string): string {
  const query = rawUrl.indexOf('?');
  if (query === -1) return rawUrl;
  let out = '';
  let from = 0;
  for (let i = query; i < rawUrl.length; i++) {
    const c = rawUrl.charCodeAt(i);
    if (c !== QUESTION && c !== AMPERSAND) continue;
    // the pair's '=', within the longest name that can decode to `token`
    let equals = -1;
    for (let j = i + 1; j < rawUrl.length && j <= i + 1 + TOKEN_NAME_MAX; j++) {
      const d = rawUrl.charCodeAt(j);
      if (d === EQUALS) {
        equals = j;
        break;
      }
      if (d === AMPERSAND) break;
    }
    if (equals === -1 || !isTokenName(rawUrl.slice(i + 1, equals))) continue;
    let end = equals + 1;
    while (end < rawUrl.length) {
      const d = rawUrl.charCodeAt(end);
      if (d === AMPERSAND || d === HASH) break;
      end++;
    }
    out += `${rawUrl.slice(from, equals + 1)}${REDACTED}`;
    from = end;
    i = end - 1;
  }
  return from === 0 ? rawUrl : out + rawUrl.slice(from);
}
