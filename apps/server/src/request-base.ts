import type { IncomingMessage } from 'node:http';
import type { FastifyRequest } from 'fastify';
import { forwardedPrefix, stripBasePath } from './base-path';

/*
 * The base path of each request (docs/subpath.md). Before anything routes a request, HTTP requests
 * (Fastify's rewriteUrl, app.ts) and WebSocket upgrades (an 'upgrade' listener that runs before
 * the sync server's, app.ts) lose the base their URL starts with, and the raw request keeps what
 * was read: the base the server writes into the request's pages and links, the bases a path the
 * request names may start with, whether the URL was the base without its slash, and the URL as
 * the client sent it (for the logs).
 */

/** What the server read of a request's base path before routing it (rewriteRequestUrl). */
export interface RequestBase {
  /**
   * The base the server writes into the request's pages and links ('' = the root): its
   * X-Forwarded-Prefix when usable, else BASE_PATH.
   */
  base: string;
  /** The bases a path of the request may start with: `base`, then BASE_PATH. */
  bases: readonly string[];
  /** The base removed from the URL ('' when it started with none). */
  removed: string;
  /** The URL was the base without its slash (`/3d`, `/3d?x`): its page is at `${removed}/`. */
  bare: boolean;
  /** The URL as the client (or the proxy) sent it, base included. */
  originalUrl: string;
}

const kRequestBase = Symbol('3d-editor.requestBase');

type WithRequestBase = IncomingMessage & { [kRequestBase]?: RequestBase };

/**
 * The URL of `req` without its base, which the request keeps (requestBase): the base the URL starts
 * with, the request's (X-Forwarded-Prefix when usable, else `basePath`) or `basePath`. Any other URL
 * is returned as it is.
 */
export function rewriteRequestUrl(req: IncomingMessage, basePath: string): string {
  const originalUrl = req.url ?? '/';
  const base = forwardedPrefix(req.headers['x-forwarded-prefix']) ?? basePath;
  const bases = base === basePath ? [base] : [base, basePath];
  const stripped = stripBasePath(originalUrl, bases);
  (req as WithRequestBase)[kRequestBase] = {
    base,
    bases,
    removed: stripped.base,
    bare: stripped.bare,
    originalUrl,
  };
  return stripped.url;
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
