import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACTOR_KINDS } from '@3d-editor/core';
import { strictArgObject } from '../mcp/strict-args';
import { MAX_PREVIS_WAIT_S } from '../rideo';
import { rideoIdSchema, rideoProjectIdSchema } from '../rideo/schemas';
import { REFERENCE_MODES } from '../rideo/shots';
import type { ServerServices } from '../services';
import { PASS_NAMES } from '../video/params';
import { badRequest, sendRestError } from './errors';

/*
 * REST routes of the rideo bridge (SPEC §11):
 *   POST /api/rideo/previs        rideo_import + a draft export_video + rideo_push as one job (202)
 *   GET  /api/rideo/previs/:job   the job (?wait=<s> waits up to 50 s for it to move on)
 * The body names the rideo clip ({rideo: {url?, token?, project, clip}}), optionally our project,
 * export parameters over the previs defaults (quality draft, look clay, clips only, rideo's fps and
 * size), push options and the video model's duration limits (default: rideo's). Failures answer
 * {error, code}: 503 UPSTREAM when rideo is down, 400 NEEDS_KEY for a token rideo refuses, 404
 * NOT_FOUND for a clip rideo does not have or an unknown job, 409 QUEUE_FULL …
 */

export const rideoTargetSchema = strictArgObject({
  url: z.string().min(1).max(2000).optional(),
  token: z.string().min(1).max(4096).optional(),
  project: rideoProjectIdSchema,
  clip: rideoIdSchema,
});

const previsBody = strictArgObject({
  rideo: rideoTargetSchema,
  project: z.string().trim().min(1).max(200).optional(),
  export: z.record(z.string(), z.unknown()).optional(),
  push: strictArgObject({
    shots: z.array(z.string().min(1)).min(1).max(512).optional(),
    mode: z.enum(REFERENCE_MODES).optional(),
    pass: z.enum(PASS_NAMES).optional(),
    write_blocking: z.boolean().optional(),
  }).optional(),
  cast_overrides: z.record(z.string(), z.enum(ACTOR_KINDS)).optional(),
  use_store_models: z.boolean().optional(),
  model_limits: strictArgObject({
    min_s: z.number().positive().max(3600),
    max_s: z.number().positive().max(3600),
  }).optional(),
});

const jobParams = z.object({ job: z.string().min(1).max(100) });
const statusQuery = z.object({ wait: z.coerce.number().min(0).max(MAX_PREVIS_WAIT_S).optional() });

export function registerRideoRoutes(app: FastifyInstance, services: ServerServices): void {
  app.post('/api/rideo/previs', async (request, reply) => {
    const body = previsBody.safeParse(request.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    try {
      return reply.code(202).send(await services.rideo.startPrevis(body.data));
    } catch (err) {
      return sendRestError(reply, err, 'rideo previs');
    }
  });

  app.get('/api/rideo/previs/:job', async (request, reply) => {
    const p = jobParams.safeParse(request.params);
    if (!p.success) return badRequest(reply, p.error);
    const q = statusQuery.safeParse(request.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    // a long poll ends when the client goes away (the job goes on)
    const abort = new AbortController();
    request.raw.once('close', () => abort.abort());
    try {
      return await services.rideo.previsStatus(p.data.job, { waitS: q.data.wait, signal: abort.signal });
    } catch (err) {
      return sendRestError(reply, err, 'rideo previs status');
    }
  });
}
