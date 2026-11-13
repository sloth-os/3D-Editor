import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerServices } from '../services';
import type { ExportFileRef } from '../video';
import { etagMatches, parseRange } from '../video/files';
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

/**
 * Sends an export file: 304 when If-None-Match matches its ETag, 206 with Content-Range for one
 * satisfiable byte range (unless If-Range names another ETag), 416 for an unsatisfiable one, else
 * the whole file; HEAD gets the headers only. Files are streamed from disk.
 */
export function sendExportFile(
  request: FastifyRequest,
  reply: FastifyReply,
  file: ExportFileRef,
): FastifyReply {
  const name = file.path.split(/[\\/]/).pop() ?? 'file';
  reply
    .header('accept-ranges', 'bytes')
    .header('etag', file.etag)
    .header('cache-control', 'private, max-age=3600')
    .header('content-type', file.contentType)
    .header('content-disposition', `inline; filename="${name.replace(/["\\\r\n]/g, '_')}"`);
  if (etagMatches(request.headers['if-none-match'], file.etag)) return reply.code(304).send();
  const ifRange = String(request.headers['if-range'] ?? '').trim();
  // If-Range with another validator (an older version of the file): the whole file
  const rangeHeader = ifRange && ifRange !== file.etag ? undefined : request.headers.range;
  const range = parseRange(rangeHeader, file.bytes);
  if (range === 'unsatisfiable')
    return reply.code(416).header('content-range', `bytes */${file.bytes}`).send();
  const start = range?.start ?? 0;
  const end = range?.end ?? file.bytes - 1;
  const length = file.bytes === 0 ? 0 : end - start + 1;
  if (range) reply.code(206).header('content-range', `bytes ${start}-${end}/${file.bytes}`);
  reply.header('content-length', length);
  // HEAD (Fastify's automatic HEAD route of the GET): an empty stream, because an empty payload
  // would make it answer Content-Length 0
  if (request.method === 'HEAD') return reply.send(Readable.from([]));
  if (length === 0) return reply.send();
  return reply.send(createReadStream(file.path, { start, end }));
}

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
    let file: ExportFileRef;
    try {
      file = await services.exports.file(p.export, p['*'], { project: p.id });
    } catch (err) {
      return sendRestError(reply, err, 'video export file');
    }
    return sendExportFile(request, reply, file);
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
