import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerServices } from '../services';
import { MAX_STORE_RESULTS, STORE_CATEGORIES } from '../store';
import { strictArgObject } from '../mcp/strict-args';
import { badRequest, sendRestError } from './errors';

/*
 * REST routes of the model store (SPEC §10), the same store as the MCP store tools:
 *   GET  /api/store/providers                    the configured providers and their state
 *   GET  /api/store/search?query=&category=&providers=a,b&limit=&cursor=
 *   GET  /api/store/models/:model                one model ('<provider>:<id>')
 *   GET  /api/store/models/:model/thumbnail      its thumbnail (proxied, cached)
 *   GET  /api/store/models/:model/files/*        its files (a cached download proxy: the browser
 *                                                inserts external models with core store.insert_files)
 *   POST /api/projects/:id/store                 insert a model into a project
 * Failures answer {error, code}: 503 UNAVAILABLE / UPSTREAM, 409 NOT_DOWNLOADABLE, 400 NEEDS_KEY …
 */

const searchQuery = z.object({
  query: z.string().max(200).optional(),
  category: z.enum(STORE_CATEGORIES).optional(),
  /** Comma-separated provider ids. */
  providers: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_STORE_RESULTS).default(20),
  cursor: z.string().min(1).optional(),
});
const modelParams = z.object({ model: z.string().min(1) });
const fileParams = modelParams.extend({ '*': z.string().default('') });
const projectParams = z.object({ id: z.string().min(1) });
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const insertBody = strictArgObject({
  model: z.string().min(1),
  location: vec3.optional(),
  rotation_deg: z.number().optional(),
  height_m: z.number().positive().max(1000).optional(),
  width_m: z.number().positive().max(1000).optional(),
  depth_m: z.number().positive().max(1000).optional(),
  name: z.string().min(1).max(200).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'expected a colour as #rrggbb')
    .optional(),
});

/** The end of a request (the client went away), for the store's network calls. */
function requestSignal(request: { raw: NodeJS.EventEmitter }): AbortSignal {
  const abort = new AbortController();
  request.raw.once('close', () => abort.abort());
  return abort.signal;
}

export function registerStoreRoutes(app: FastifyInstance, services: ServerServices): void {
  app.get('/api/store/providers', async (_request, reply) => {
    try {
      return { providers: await services.store.providers() };
    } catch (err) {
      return sendRestError(reply, err, 'listing the store providers');
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
        { signal: requestSignal(request) },
      );
    } catch (err) {
      return sendRestError(reply, err, 'store search');
    }
  });

  app.get('/api/store/models/:model', async (request, reply) => {
    const { model } = modelParams.parse(request.params);
    try {
      return await services.store.details(model, { signal: requestSignal(request) });
    } catch (err) {
      return sendRestError(reply, err, 'store model');
    }
  });

  app.get('/api/store/models/:model/thumbnail', async (request, reply) => {
    const { model } = modelParams.parse(request.params);
    try {
      const file = await services.store.thumbnail(model, { signal: requestSignal(request) });
      if (file.etag) reply.header('etag', file.etag);
      return reply.header('content-type', file.contentType).send(Buffer.from(file.data));
    } catch (err) {
      return sendRestError(reply, err, 'store thumbnail');
    }
  });

  app.get('/api/store/models/:model/files/*', async (request, reply) => {
    const p = fileParams.parse(request.params);
    try {
      const file = await services.store.files(p.model, p['*'], { signal: requestSignal(request) });
      if (file.etag) reply.header('etag', file.etag);
      return reply.header('content-type', file.contentType).send(Buffer.from(file.data));
    } catch (err) {
      return sendRestError(reply, err, 'store file');
    }
  });

  app.post('/api/projects/:id/store', async (request, reply) => {
    const { id } = projectParams.parse(request.params);
    const body = insertBody.safeParse(request.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    const { model, ...opts } = body.data;
    try {
      return await services.store.insert(id, model, opts, { signal: requestSignal(request) });
    } catch (err) {
      return sendRestError(reply, err, 'store insert');
    }
  });
}
