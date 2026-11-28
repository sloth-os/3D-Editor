import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { pathnameOf } from './auth';
import { isReservedPath, withBaseHref } from './base-path';
import {
  DEFAULT_DESK_EMBED,
  deskHeadersFor,
  deskPageHeaders,
  isDeskPagePath,
  type DeskEmbedSettings,
} from './desk-embed';
import { requestBase } from './request-base';

/** The server's own paths (base-path.ts): they never fall back to the editor's page. */
export { RESERVED_PREFIXES, isReservedPath } from './base-path';

/**
 * Cache policy for a file relative to the public root (posix separators): content-hashed build
 * output under assets/ is immutable; everything else (index.html, sw.js, registerSW.js,
 * workbox-*.js, manifest.webmanifest, icons) must be revalidated so updates reach clients.
 */
export function cacheControlFor(relativePath: string): string {
  return relativePath.replace(/^\/+/, '').startsWith('assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}

/** The pages the server writes per request with the request's `<base href>`. */
type PageFile = 'index.html' | 'desk.html';

/**
 * Whether fastify-static may send a path itself: never a page (they are written per request,
 * sendPage) and no directory (no index, no listing: the editor's page answers those paths).
 */
function servedAsFile(pathname: string): boolean {
  const rel = pathname.replace(/^\/+/, '');
  return rel !== '' && !rel.endsWith('/') && rel !== 'index.html' && rel !== 'desk.html';
}

/** Whether an If-None-Match header names `etag` (weak comparison, as for GET). */
function notModified(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === '*' || tag === etag);
}

/** Adds a header name to the reply's Vary (kept with a Vary set before, e.g. Origin by CORS). */
function addVary(reply: FastifyReply, name: string): void {
  const before = reply.getHeader('vary');
  const names = (Array.isArray(before) ? before.join(',') : String(before ?? ''))
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (!names.some((v) => v === '*' || v.toLowerCase() === name.toLowerCase())) names.push(name);
  reply.header('vary', names.join(', '));
}

/**
 * Serves the PWA from `publicDir` with SPA fallback (unknown GET routes outside the API get the
 * editor's page). The two pages, the editor's index.html (at /, /index.html and every path that
 * falls back to it) and the embeddable desk's desk.html (at /desk.html and /desk), are written per
 * request with the request's `<base href>` (docs/subpath.md), with Cache-Control no-cache and
 * Vary: X-Forwarded-Prefix; fastify-static never sends them as they are. The desk page and the
 * built assets get the desk's headers (desk-embed.ts: COEP, CORP, CSP frame-ancestors; never
 * X-Frame-Options). Returns false when there is nothing to serve (API-only mode).
 */
export async function registerStatic(
  app: FastifyInstance,
  publicDir: string | null,
  desk: DeskEmbedSettings = DEFAULT_DESK_EMBED,
): Promise<boolean> {
  const hasIndex = !!publicDir && existsSync(path.join(publicDir, 'index.html'));
  // the path as the client sent it, base included
  const notFound = (request: FastifyRequest, reply: FastifyReply) =>
    reply.code(404).send({ error: `not found: ${pathnameOf(request.originalUrl)}` });

  if (!hasIndex || !publicDir) {
    app.setNotFoundHandler(notFound);
    return false;
  }
  const root = path.resolve(publicDir);
  await app.register(fastifyStatic, {
    root,
    prefix: '/',
    wildcard: true,
    index: false,
    allowedPath: servedAsFile,
    cacheControl: false,
    etag: true,
    lastModified: true,
    setHeaders(reply, file) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      reply.header('cache-control', cacheControlFor(rel));
      reply.headers(deskHeadersFor(rel, desk));
    },
  });

  /** A page with the request's `<base href>`, or 404 when the build has no such page. */
  const sendPage = async (
    request: FastifyRequest,
    reply: FastifyReply,
    file: PageFile,
    headers: Record<string, string>,
  ) => {
    let html: string;
    try {
      html = await readFile(path.join(root, file), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return notFound(request, reply);
      throw err;
    }
    const page = withBaseHref(html, requestBase(request));
    const etag = `"${createHash('sha256').update(page).digest('base64url').slice(0, 27)}"`;
    reply.headers({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      etag,
      ...headers,
    });
    // the page depends on X-Forwarded-Prefix: a shared cache keys it on the header
    addVary(reply, 'X-Forwarded-Prefix');
    if (notModified(request.headers['if-none-match'], etag)) return reply.code(304).send();
    return reply.send(page);
  };

  app.setNotFoundHandler((request, reply) => {
    const pathname = pathnameOf(request.url);
    const isPage = request.method === 'GET' || request.method === 'HEAD';
    if (!isPage || isReservedPath(pathname) || pathname.startsWith('/assets/'))
      return notFound(request, reply);
    // the desk's clean URL (/desk): the desk page, never the editor's index.html
    if (isDeskPagePath(pathname)) return sendPage(request, reply, 'desk.html', deskPageHeaders(desk));
    return sendPage(request, reply, 'index.html', {});
  });
  return true;
}
