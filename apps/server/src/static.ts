import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { pathnameOf } from './auth';

/** Path prefixes that belong to the server API and never fall back to the SPA. */
export const RESERVED_PREFIXES = [
  '/api',
  '/sync',
  '/mcp',
  '/dav',
  '/otlp',
  '/metrics',
  '/healthz',
  '/readyz',
];

export function isReservedPath(pathname: string): boolean {
  return RESERVED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

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

/**
 * Serves the PWA from `publicDir` with SPA fallback (unknown GET routes outside the API get
 * index.html). Returns false when there is nothing to serve (API-only mode).
 */
export async function registerStatic(app: FastifyInstance, publicDir: string | null): Promise<boolean> {
  const hasIndex = !!publicDir && existsSync(path.join(publicDir, 'index.html'));
  const notFound = (reply: FastifyReply, url: string) =>
    reply.code(404).send({ error: `not found: ${pathnameOf(url)}` });

  if (!hasIndex || !publicDir) {
    app.setNotFoundHandler((request, reply) => notFound(reply, request.url));
    return false;
  }
  const root = path.resolve(publicDir);
  await app.register(fastifyStatic, {
    root,
    prefix: '/',
    wildcard: true,
    index: ['index.html'],
    cacheControl: false,
    etag: true,
    lastModified: true,
    setHeaders(reply, file) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      reply.header('cache-control', cacheControlFor(rel));
    },
  });
  app.setNotFoundHandler((request, reply) => {
    const pathname = pathnameOf(request.url);
    const isPage = request.method === 'GET' || request.method === 'HEAD';
    if (!isPage || isReservedPath(pathname) || pathname.startsWith('/assets/'))
      return notFound(reply, request.url);
    return reply.header('cache-control', 'no-cache').sendFile('index.html');
  });
  return true;
}
