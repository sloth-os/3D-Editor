import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerServices } from '../services';
import { MAX_EXPORT_WAIT_S, videoExportParamsSchema } from '../video/params';
import { badRequest, sendRestError } from './errors';

/*
 * REST routes of video exports (SPEC §9), the same jobs as the MCP export tools:
 *   POST   /api/projects/:id/video-exports            start an export (202 with the job)
 *   GET    /api/projects/:id/video-exports            the project's exports
 *   GET    /api/projects/:id/video-exports/:export    one export (?wait=<s> waits up to 50 s)
 *   GET    /api/projects/:id/video-exports/:export/files/*   a file (Range, ETag)
 *   DELETE /api/projects/:id/video-exports/:export    cancel it and delete its files
 * Failures answer {error, code}: 503 UNAVAILABLE / FFMPEG_UNAVAILABLE, 409 QUEUE_FULL, 404 …
 */

const projectParams = z.object({ id: z.string().min(1) });
const exportParams = z.object({ id: z.string().min(1), export: z.string().min(1) });
const fileParams = exportParams.extend({ '*': z.string().min(1) });
const statusQuery = z.object({ wait: z.coerce.number().min(0).max(MAX_EXPORT_WAIT_S).optional() });

export function registerVideoExportRoutes(app: FastifyInstance, services: ServerServices): void {
  app.post('/api/projects/:id/video-exports', async (request, reply) => {
    const { id } = projectParams.parse(request.params);
    const body = videoExportParamsSchema.safeParse(request.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    try {
      return reply.code(202).send(await services.exports.start(id, body.data));
    } catch (err) {
      return sendRestError(reply, err, 'video export');
    }
  });

  app.get('/api/projects/:id/video-exports', async (request, reply) => {
    const { id } = projectParams.parse(request.params);
    try {
      return { exports: await services.exports.list(id) };
    } catch (err) {
      return sendRestError(reply, err, 'listing video exports');
    }
  });

  app.get('/api/projects/:id/video-exports/:export', async (request, reply) => {
    const p = exportParams.parse(request.params);
    const q = statusQuery.safeParse(request.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    // a long poll ends when the client goes away (the export goes on)
    const abort = new AbortController();
    request.raw.once('close', () => abort.abort());
    try {
      return await services.exports.status(p.export, {
        project: p.id,
        waitS: q.data.wait,
        signal: abort.signal,
      });
    } catch (err) {
      return sendRestError(reply, err, 'video export status');
    }
  });

  app.get('/api/projects/:id/video-exports/:export/files/*', async (request, reply) => {
    const p = fileParams.parse(request.params);
    try {
      const file = await services.exports.file(p.export, p['*'], { project: p.id });
      // VIDEO serves the file with Range and ETag; the stub never gets here
      return reply.code(501).send({ error: `serving ${file.path} is not implemented yet` });
    } catch (err) {
      return sendRestError(reply, err, 'video export file');
    }
  });

  app.delete('/api/projects/:id/video-exports/:export', async (request, reply) => {
    const p = exportParams.parse(request.params);
    try {
      return await services.exports.cancel(p.export, { project: p.id, deleteFiles: true });
    } catch (err) {
      return sendRestError(reply, err, 'cancelling the video export');
    }
  });
}
