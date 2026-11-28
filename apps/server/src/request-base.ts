import type { IncomingMessage } from 'node:http';
import type { FastifyRequest } from 'fastify';
import { forwardedPrefix, startsWithOwnPath, stripBasePath } from './base-path';
import { originForm } from './request-target';

/** A request target in origin form, as the router reads it (request-target.ts). */
export { originForm } from './request-target';

/*
 * The base path of each request (docs/subpath.md). Before anything routes a request, HTTP requests
 * (Fastify's rewriteUrl, app.ts) and WebSocket upgrades (an 'upgrade' listener that runs before
 * the sync server's, app.ts) get their URL in origin form (originForm, request-target.ts), and the
 * raw request keeps what was read: the base the server writes into the request's pages and links,
 * the bases a path the request names may start with, whether the request carries
 * X-Forwarded-Prefix, whether the URL was BASE_PATH without its slash, and the URL as the client
 * sent it (for the logs).
 *
 * A request that carries X-Forwarded-Prefix with a value that is not blank (usable or not, in any
 * number of header lines) came through a proxy that stripped the prefix: its URL is routed as it
 * came, and nothing is removed from it. Only from a request without the header is BASE_PATH removed,
 * when its URL starts with it. The header's value sets the base the server writes, never what a
 * request routes to: clients can send it, and a proxy in front that passes it on (and denies
 * /metrics or /mcp, say) would otherwise let any client re-root routing under a prefix of its
 * choice; and a path a stripping proxy passed on is never stripped again (with BASE_PATH=/3d, a
 * client's /3d/3d/metrics reaches the server as /3d/metrics with the header, which no route serves).
 * So the header's base may start with one of the server's own paths (an editor at the root behind a
 * stripping proxy at /api/), which BASE_PATH may not: no path is read two ways.
 */

/** What the server read of a request's base path before routing it (rewriteRequestUrl). */
export interface RequestBase {
  /**
   * The base the server writes into the request's pages and links ('' = the root): its
   * X-Forwarded-Prefix when usable, else BASE_PATH.
   */
  base: string;
  /** The bases a path the request names (a WebDAV Destination) may start with: `base`, then BASE_PATH. */
  bases: readonly string[];
  /**
   * The request carries X-Forwarded-Prefix with a value that is not blank (carriesForwardedPrefix):
   * its URL was routed as it came.
   */
  forwarded: boolean;
  /** The base its X-Forwarded-Prefix names when usable (forwardedPrefix), else null. */
  forwardedBase: string | null;
  /** BASE_PATH when the URL started with it and lost it (a request without the header), else ''. */
  removed: string;
  /** The URL was BASE_PATH without its slash (`/3d`, `/3d?x`): its page is at `${removed}/`. */
  bare: boolean;
  /** The URL as the client (or the proxy) sent it, base included. */
  originalUrl: string;
}

const kRequestBase = Symbol('3d-editor.requestBase');

type WithRequestBase = IncomingMessage & { [kRequestBase]?: RequestBase };

const SPACE = 32;
const TAB = 9;

const FORWARDED_PREFIX = 'x-forwarded-prefix';

/** Whether a header value is empty once spaces and tabs are trimmed from it. */
function isBlank(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c !== SPACE && c !== TAB) return false;
  }
  return true;
}

/**
 * Whether a request carries X-Forwarded-Prefix with a value that is not blank (after trimming spaces
 * and tabs), usable or not, in any of its header lines: then a proxy stripped the prefix from its
 * path (docs/subpath.md). Read from the raw header lines, since Node joins several lines with ', '
 * (two empty lines would read ', '); a request without them (built by hand) is read from its
 * headers. Time linear in the size of the headers.
 */
export function carriesForwardedPrefix(req: Pick<IncomingMessage, 'headers' | 'rawHeaders'>): boolean {
  const raw = req.rawHeaders as readonly string[] | undefined;
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const name = raw[i]!;
      if (name.length === FORWARDED_PREFIX.length && name.toLowerCase() === FORWARDED_PREFIX) {
        if (!isBlank(raw[i + 1]!)) return true;
      }
    }
    return false;
  }
  const value = req.headers[FORWARDED_PREFIX];
  const values = typeof value === 'string' ? [value] : (value ?? []);
  return values.some((v) => !isBlank(v));
}

/**
 * The URL of `req` in origin form (originForm), without BASE_PATH (`basePath`) when it starts with
 * it and the request carries no X-Forwarded-Prefix (carriesForwardedPrefix); the request keeps what
 * was read (requestBase). A request that carries the header is routed as it came: the proxy that
 * sent it stripped the prefix. The header's value is read for the base the server writes, never
 * removed from the URL.
 */
export function rewriteRequestUrl(req: IncomingMessage, basePath: string): string {
  const originalUrl = req.url ?? '/';
  const forwardedBase = forwardedPrefix(req.headers[FORWARDED_PREFIX]);
  const base = forwardedBase ?? basePath;
  const bases = base === basePath ? [base] : [base, basePath];
  const forwarded = carriesForwardedPrefix(req);
  const target = originForm(originalUrl);
  const stripped = forwarded ? { url: target, base: '', bare: false } : stripBasePath(target, [basePath]);
  (req as WithRequestBase)[kRequestBase] = {
    base,
    bases,
    forwarded,
    forwardedBase,
    removed: stripped.base,
    bare: stripped.bare,
    originalUrl,
  };
  return stripped.url;
}

/**
 * The base that the URL of a request carrying X-Forwarded-Prefix still starts with, as routed
 * (`url`, after rewriteRequestUrl): the header's usable base, else BASE_PATH (`basePath`), or null
 * (no header, or a URL under neither). Such a request reaches no route: a proxy that sends the
 * header and keeps the prefix in request paths, or a client that sent a path with the prefix twice
 * through a stripping proxy, or its own header (app.ts says so in the log). A header base whose
 * first segment is one of the server's own paths (startsWithOwnPath) is no such sign, and only
 * BASE_PATH counts with it: behind a stripping proxy at /api/, the editor's own requests arrive
 * with paths under it (its /api/api/config as /api/config, with the header /api) and are served.
 */
export function keptPrefix(
  request: FastifyRequest | IncomingMessage,
  url: string,
  basePath: string,
): string | null {
  const info = requestBaseInfo(request);
  if (!info?.forwarded) return null;
  const header = info.forwardedBase;
  const bases = header && !startsWithOwnPath(header) ? [header, basePath] : [basePath];
  return stripBasePath(url, bases).base || null;
}

function rawOf(request: FastifyRequest | IncomingMessage): WithRequestBase {
  return 'raw' in request ? request.raw : request;
}

/** What rewriteRequestUrl read of a request, or null for a request it did not see. */
export function requestBaseInfo(request: FastifyRequest | IncomingMessage): RequestBase | null {
  return rawOf(request)[kRequestBase] ?? null;
}

/**
 * The base path the server writes into a request's pages and links ('' = the root): what
 * rewriteRequestUrl read, else (a request it did not see) its usable X-Forwarded-Prefix.
 */
export function requestBase(request: FastifyRequest | IncomingMessage): string {
  const raw = rawOf(request);
  return raw[kRequestBase]?.base ?? forwardedPrefix(raw.headers['x-forwarded-prefix']) ?? '';
}

/**
 * The bases a path that a request names may start with (a WebDAV Destination): the request's base,
 * then BASE_PATH.
 */
export function requestBases(request: FastifyRequest | IncomingMessage): readonly string[] {
  return requestBaseInfo(request)?.bases ?? [requestBase(request)];
}

/** The URL of a raw request as the client sent it, base included (Fastify's request.originalUrl). */
export function originalUrlOf(req: IncomingMessage): string {
  return (req as WithRequestBase)[kRequestBase]?.originalUrl ?? req.url ?? '/';
}
