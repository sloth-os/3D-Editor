import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerServices } from '../services';
import { MAX_STORE_RESULTS, STORE_CATEGORIES, type StoreFile, type StoreFileHandle } from '../store';
import { StoreCancelledError } from '../store/http';
import { strictArgObject } from '../mcp/strict-args';
import { badRequest, sendRestError } from './errors';

/*
 * REST routes of the model store (SPEC §10), the same store as the MCP store tools:
 *   GET  /api/store/providers                    the known providers and their state
 *   GET  /api/store/search?query=&category=&providers=a,b&limit=&cursor=
 *   GET  /api/store/models/:model[?download=1]   one model ('<provider>:<id>'); with download=1 its
 *                                                files are downloaded (cached) and listed
 *   GET  /api/store/models/:model/thumbnail      its thumbnail (proxied, cached; ETag)
 *   GET  /api/store/models/:model/files/*        its files ('' = the main file; a cached download
 *                                                proxy streamed from disk: the browser inserts
 *                                                external models with core store.insert_files, so
 *                                                Ctrl+Z undoes them)
 *   POST /api/projects/:id/store                 insert a model into a project
 * Failures answer {error, code}: 503 UNAVAILABLE / UPSTREAM, 409 NOT_DOWNLOADABLE, 400 NEEDS_KEY,
 * 404 NOT_FOUND, 400 INVALID_PARAMS, 507 OUT_OF_MEMORY; a request its client left answers 499.
 */

const searchQuery = z.object({
  query: z.string().max(200).optional(),
  category: z.enum(STORE_CATEGORIES).optional(),
  /** Comma-separated provider ids. */
  providers: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_STORE_RESULTS).default(20),
  cursor: z.string().min(1).max(4000).optional(),
});
const modelParams = z.object({ model: z.string().min(1).max(500) });
const detailsQuery = z.object({ download: z.enum(['1', 'true', '0', 'false']).optional() });
const fileParams = modelParams.extend({ '*': z.string().max(2000).default('') });
const projectParams = z.object({ id: z.string().min(1) });
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const insertBody = strictArgObject({
  model: z.string().min(1).max(500),
  location: vec3.optional(),
  rotation_deg: z.number().min(-3600).max(3600).optional(),
  height_m: z.number().positive().max(1000).optional(),
  width_m: z.number().positive().max(1000).optional(),
  depth_m: z.number().positive().max(1000).optional(),
  name: z.string().min(1).max(64).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'expected a colour as #rrggbb')
    .optional(),
  /** A built-in model's own parameters (checked by the model's schema). */
  params: z.record(z.string().min(1).max(64), z.unknown()).optional(),
});

/**
 * Aborts when the client goes away before its reply was sent (for the store's network calls).
 * Taken from the response, not the request: Node closes a request (IncomingMessage) as soon as its
 * body has been read — a POST's JSON right after Fastify parsed it — while the client still waits.
 */
function requestSignal(reply: FastifyReply): AbortSignal {
  const abort = new AbortController();
  const res = reply.raw;
  const gone = () => {
    if (!res.writableFinished) abort.abort();
  };
  if (res.destroyed) gone();
  else res.once('close', gone);
  return abort.signal;
}

/**
 * The reply of a failed store route: a request its client left (StoreCancelledError) answers 499
 * without a warning (nobody reads it), anything else as {@link sendRestError}.
 */
function sendStoreError(reply: FastifyReply, err: unknown, what: string): FastifyReply {
  if (err instanceof StoreCancelledError) return reply.code(499).send({ error: `${what}: cancelled` });
  return sendRestError(reply, err, what);
}

/** Whether the request's If-None-Match names `etag`. */
function notModified(request: FastifyRequest, etag: string | null): boolean {
  const match = request.headers['if-none-match'];
  return !!etag && typeof match === 'string' && match.split(',').some((t) => t.trim() === etag);
}

/** Sends a stored file with its type and ETag (304 when the client has it). */
function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  file: StoreFile,
  maxAge: number,
): FastifyReply {
  reply
    .header('content-type', file.contentType)
    .header('cache-control', `private, max-age=${maxAge}`)
    .header('x-content-type-options', 'nosniff');
  if (file.etag) reply.header('etag', file.etag);
  if (notModified(request, file.etag)) return reply.code(304).send();
  return reply.send(Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength));
}

/**
 * Sends a model's file from the cache: 304 when the client has it (nothing read), else streamed
 * from disk while the cache entry is held (a model's files are up to 200 MB).
 */
function sendModelFile(request: FastifyRequest, reply: FastifyReply, file: StoreFileHandle): FastifyReply {
  // files someone else made, served from the editor's origin: never taken for another type
  reply
    .header('content-type', file.contentType)
    .header('cache-control', 'private, max-age=3600')
    .header('x-content-type-options', 'nosniff')
    .header('etag', file.etag);
  if (notModified(request, file.etag)) {
    file.release();
    return reply.code(304).send();
  }
  const stream = createReadStream(file.path);
  stream.once('close', () => file.release());
  return reply.header('content-length', String(file.bytes)).send(stream);
}

export function registerStoreRoutes(app: FastifyInstance, services: ServerServices): void {
  app.get('/api/store/providers', async (_request, reply) => {
    try {
      return { providers: await services.store.providers() };
    } catch (err) {
      return sendStoreError(reply, err, 'listing the store providers');
    }
  });

  app.get('/api/store/search', async (request, reply) => {
    const q = searchQuery.safeParse(request.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    const { providers, ...rest } = q.data;
    try {
      return await services.store.search(
        {
          ...rest,
          providers: providers
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        },
        { signal: requestSignal(reply) },
      );
    } catch (err) {
      return sendStoreError(reply, err, 'store search');
    }
  });

  app.get('/api/store/models/:model', async (request, reply) => {
    const p = modelParams.safeParse(request.params);
    if (!p.success) return badRequest(reply, p.error);
    const q = detailsQuery.safeParse(request.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    try {
      return await services.store.details(p.data.model, {
        signal: requestSignal(reply),
        download: q.data.download === '1' || q.data.download === 'true',
      });
    } catch (err) {
      return sendStoreError(reply, err, 'store model');
    }
  });

  app.get('/api/store/models/:model/thumbnail', async (request, reply) => {
    const p = modelParams.safeParse(request.params);
    if (!p.success) return badRequest(reply, p.error);
    try {
      const file = await services.store.thumbnail(p.data.model, { signal: requestSignal(reply) });
      return sendFile(request, reply, file, 86_400);
    } catch (err) {
      return sendStoreError(reply, err, 'store thumbnail');
    }
  });

  app.get('/api/store/models/:model/files/*', async (request, reply) => {
    const p = fileParams.safeParse(request.params);
    if (!p.success) return badRequest(reply, p.error);
    try {
      const file = await services.store.openFile(p.data.model, p.data['*'], { signal: requestSignal(reply) });
      return sendModelFile(request, reply, file);
    } catch (err) {
      return sendStoreError(reply, err, 'store file');
    }
  });

  app.post('/api/projects/:id/store', async (request, reply) => {
    const { id } = projectParams.parse(request.params);
    const body = insertBody.safeParse(request.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    const { model, ...opts } = body.data;
    try {
      return await services.store.insert(id, model, opts, { signal: requestSignal(reply) });
    } catch (err) {
      return sendStoreError(reply, err, 'store insert');
    }
  });
}
