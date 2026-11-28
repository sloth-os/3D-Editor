import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
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
import { addVary } from './vary';

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
 * The files of the build in `root`, by their paths from it (posix separators), listed once when
 * the server starts: the build does not change while the server runs (a build replaced in its
 * folder is served as a whole once the server restarts). Linked files and folders count as the
 * file server follows them; a link back to a folder it is in is not followed again, so a loop ends.
 */
function listBuiltFiles(root: string): Set<string> {
  const files = new Set<string>();
  const walk = (dir: string, prefix: string, inside: readonly string[]): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable: the file server cannot send from it either
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      let isFile = entry.isFile();
      let isFolder = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          const target = statSync(file);
          isFile = target.isFile();
          isFolder = target.isDirectory();
        } catch {
          continue; // a link to nothing
        }
      }
      if (isFile) files.add(`${prefix}${entry.name}`);
      if (!isFolder) continue;
      let real: string;
      try {
        real = realpathSync(file);
      } catch {
        continue;
      }
      if (!inside.includes(real)) walk(file, `${prefix}${entry.name}/`, [...inside, real]);
    }
  };
  walk(root, '', [realpathSync(root)]);
  return files;
}

/**
 * Whether fastify-static may send a path itself (its allowedPath, given the decoded path): only a
 * file of the build (`files`, listBuiltFiles), never a page (they are written per request,
 * sendPage), and never a folder, with or without its slash: every other path falls to the
 * not-found handler (the editor's page or 404). fastify-static would answer a folder path without
 * its slash (`/icons`) itself, with an empty 200: it calls reply.callNotFound() for a folder
 * without returning it, so Fastify sends the route's empty answer before the not-found handler's
 * (and logs "Reply was already sent"). A set of the files, not a file-system check: allowedPath is
 * synchronous, so a stat here would hold up the server at every request the file server's route
 * takes (every page path too), and the build does not change while the server runs.
 */
function servedAsFile(files: ReadonlySet<string>, pathname: string): boolean {
  const rel = pathname.replace(/^\/+/, '');
  return rel !== 'index.html' && rel !== 'desk.html' && files.has(rel);
}

/** Whether an If-None-Match header names `etag` (weak comparison, as for GET). */
function notModified(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === '*' || tag === etag);
}

/**
 * Serves the PWA from `publicDir` with SPA fallback (unknown GET routes outside the API get the
 * editor's page). fastify-static sends the build's files, listed when the server starts
 * (servedAsFile); every other GET or HEAD outside the server's own paths and `/assets/`, a folder
 * of the build (`/icons`, `/icons/`) too, gets the editor's page (/desk the desk's). The two
 * pages, the editor's index.html (at /, /index.html and every path that falls back to it) and the
 * embeddable desk's desk.html (at /desk.html and /desk), are written per request with the
 * request's `<base href>` (docs/subpath.md), with Cache-Control no-cache and Vary:
 * X-Forwarded-Prefix; fastify-static never sends them as they are. The desk page and the built
 * assets get the desk's headers (desk-embed.ts: COEP, CORP, CSP frame-ancestors; never
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
  const files = listBuiltFiles(root);
  await app.register(fastifyStatic, {
    root,
    prefix: '/',
    wildcard: true,
    index: false,
    allowedPath: (pathname) => servedAsFile(files, pathname),
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
