import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { exportScene, type ExportFormat } from '@3d-editor/core';
import type { RoomManager } from '../sync/room-manager';
import { StorageUnavailableError } from '../sync/room-manager';
import type { Room } from '../sync/room';
import { errorMessage, withSpan, withSpanSync } from '../observability/tracing';
import { RenderRequestError, isCancelled, sharedRenderer, type Renderer } from '../render';
import { sharedRenderStore, type RenderStore } from '../render/store';

export const EXPORT_FORMATS = ['glb', 'gltf', 'obj', 'stl', 'ply'] as const;

const createBody = z.object({
  name: z.string().trim().min(1).max(200).default('Untitled'),
  empty: z.boolean().default(false),
});
const renameBody = z.object({ name: z.string().trim().min(1).max(200) });
const idParams = z.object({ id: z.string() });
const exportQuery = z.object({ format: z.enum(EXPORT_FORMATS).default('glb') });
const queryBool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
  .transform((v) => ['true', '1', 'yes', 'on'].includes(v));
/** Options of GET /api/projects/:id/render.png (the same as the MCP render_image tool). */
const renderQuery = z.object({
  width: z.coerce.number().int().min(16).max(2048).default(800),
  height: z.coerce.number().int().min(16).max(2048).optional(),
  camera: z.string().optional(),
  frame: z.coerce.number().optional(),
  engine: z.enum(['RASTER', 'PATHTRACER']).optional(),
  shading: z.enum(['SOLID', 'MATERIAL']).optional(),
  samples: z.coerce.number().int().min(1).max(4096).optional(),
  max_bounces: z.coerce.number().int().min(0).max(64).optional(),
  denoise: queryBool.optional(),
  time_limit: z.coerce.number().min(0.1).max(600).optional(),
  seed: z.coerce.number().int().min(0).max(2147483647).optional(),
});
/** Default sampling time budget of path traced REST renders (seconds). */
const DEFAULT_RENDER_TIME_LIMIT = 30;
const renderFileParams = z.object({ id: z.string(), render: z.string(), file: z.string() });

export interface ProjectRouteOptions {
  /** Renderer for render.png (default: the process-wide one). */
  renderer?: Renderer;
  /** Stored render results served under /renders (default: the process-wide store). */
  renderStore?: RenderStore;
}

/** True for errors thrown by core functions that other packages have not implemented yet. */
export function isNotImplemented(err: unknown): boolean {
  return err instanceof Error && /not implemented/i.test(err.message);
}

function badRequest(reply: FastifyReply, error: z.ZodError | string) {
  const message =
    typeof error === 'string'
      ? error
      : error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
  return reply.code(400).send({ error: message });
}

/** Builds a safe download file name from a project name. */
export function safeFileName(name: string, ext: string): string {
  const base = name.replace(/[^\w.-]+/g, '_').replace(/^[_.]+|[_.]+$/g, '') || 'scene';
  return `${base.slice(0, 80)}.${ext}`;
}

export function registerProjectRoutes(
  app: FastifyInstance,
  rooms: RoomManager,
  opts: ProjectRouteOptions = {},
): void {
  const renderer = () => opts.renderer ?? sharedRenderer({ log: app.log });
  const renderStore = opts.renderStore ?? sharedRenderStore();

  /** Loads a project or replies 404/503. */
  async function roomOr404(id: string, reply: FastifyReply): Promise<Room | null> {
    try {
      const room = await rooms.open(id);
      if (!room) {
        await reply.code(404).send({ error: `project '${id}' not found` });
        return null;
      }
      return room;
    } catch (err) {
      if (err instanceof StorageUnavailableError) {
        await reply.code(503).send({ error: err.message });
        return null;
      }
      throw err;
    }
  }

  app.get('/api/projects', async () => ({ projects: await rooms.listProjects() }));

  app.post('/api/projects', async (request, reply) => {
    const body = createBody.safeParse(request.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    const room = await rooms.createProject(body.data);
    return reply.code(201).send({ id: room.id, name: room.scene.name });
  });

  app.get('/api/projects/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const room = await roomOr404(id, reply);
    if (!room) return reply;
    return { ...room.listing(), persistence: rooms.persistence.mode };
  });

  app.patch('/api/projects/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = renameBody.safeParse(request.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    const room = await roomOr404(id, reply);
    if (!room) return reply;
    room.scene.setName(body.data.name);
    return room.listing();
  });

  app.delete('/api/projects/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const deleted = await rooms.deleteProject(id);
    if (!deleted) return reply.code(404).send({ error: `project '${id}' not found` });
    renderStore.forgetProject(id);
    return reply.code(204).send();
  });

  app.get('/api/projects/:id/snapshot', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const room = await roomOr404(id, reply);
    if (!room) return reply;
    return withSpanSync('project.snapshot', { 'project.id': id }, () => room.scene.toSnapshot());
  });

  app.get('/api/projects/:id/export', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const q = exportQuery.safeParse(request.query);
    if (!q.success) return badRequest(reply, `format must be one of ${EXPORT_FORMATS.join(', ')}`);
    const room = await roomOr404(id, reply);
    if (!room) return reply;
    try {
      const result = await withSpan(
        'project.export',
        { 'project.id': id, 'export.format': q.data.format },
        () => exportScene(room.scene, q.data.format as ExportFormat),
      );
      return reply
        .header('content-type', result.mime)
        .header(
          'content-disposition',
          `attachment; filename="${safeFileName(room.scene.name, result.extension)}"`,
        )
        .header('cache-control', 'no-store')
        .send(Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength));
    } catch (err) {
      if (isNotImplemented(err)) return reply.code(501).send({ error: errorMessage(err) });
      return reply.code(500).send({ error: `export failed: ${errorMessage(err)}` });
    }
  });

  app.get('/api/projects/:id/render.png', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const q = renderQuery.safeParse(request.query);
    if (!q.success) return badRequest(reply, q.error);
    const room = await roomOr404(id, reply);
    if (!room) return reply;
    const render = room.scene.getRender();
    const width = q.data.width;
    const height =
      q.data.height ??
      Math.min(
        2048,
        Math.max(16, Math.round((width * render.resolution_y) / Math.max(1, render.resolution_x))),
      );
    let cameraId: string | undefined;
    if (q.data.camera) {
      const cam = room.scene.resolveObject(q.data.camera);
      if (!cam || cam.type !== 'CAMERA')
        return reply.code(400).send({ error: `camera '${q.data.camera}' not found` });
      cameraId = cam.id;
    }
    const engine = q.data.engine ?? render.engine;
    // a client that goes away cancels its render
    const abort = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) abort.abort();
    };
    reply.raw.once('close', onClose);
    try {
      const result = await withSpan(
        'project.render',
        { 'project.id': id, 'render.width': width, 'render.height': height, 'render.engine': engine },
        () =>
          renderer().renderImage({
            scene: room.scene,
            projectId: id,
            signal: abort.signal,
            options: {
              width,
              height,
              frame: q.data.frame ?? room.scene.getScene().frame_start,
              engine,
              cameraId,
              shading: q.data.shading,
              samples: q.data.samples,
              max_bounces: q.data.max_bounces,
              denoise: q.data.denoise,
              time_limit:
                engine === 'PATHTRACER' ? (q.data.time_limit ?? DEFAULT_RENDER_TIME_LIMIT) : undefined,
              seed: q.data.seed,
            },
          }),
      );
      const png = result.png;
      reply
        .header('content-type', 'image/png')
        .header('cache-control', 'no-store')
        .header('x-render-engine', result.engine)
        .header('x-render-threads', String(result.threads))
        .header('x-render-time-ms', String(result.elapsedMs));
      if (result.pathtrace) reply.header('x-render-samples', String(result.pathtrace.samples));
      return reply.send(Buffer.from(png.buffer, png.byteOffset, png.byteLength));
    } catch (err) {
      if (isCancelled(err)) return reply.code(499).send({ error: 'render cancelled' });
      if (err instanceof RenderRequestError) return reply.code(400).send({ error: err.message });
      if (isNotImplemented(err)) return reply.code(501).send({ error: errorMessage(err) });
      return reply.code(500).send({ error: `render failed: ${errorMessage(err)}` });
    } finally {
      reply.raw.off('close', onClose);
    }
  });

  /** Files of a stored render (render_animation `store: true`). */
  app.get('/api/projects/:id/renders/:render', async (request, reply) => {
    const { id, render } = z.object({ id: z.string(), render: z.string() }).parse(request.params);
    const files = renderStore.list(id, render);
    if (!files) return reply.code(404).send({ error: 'render not found (renders are kept for an hour)' });
    return { id: render, files };
  });

  app.get('/api/projects/:id/renders/:render/:file', async (request, reply) => {
    const { id, render, file } = renderFileParams.parse(request.params);
    const f = renderStore.get(id, render, file);
    if (!f) return reply.code(404).send({ error: 'file not found (renders are kept for an hour)' });
    return reply
      .header('content-type', f.mime)
      .header(
        'content-disposition',
        `attachment; filename="${safeFileName(file.replace(/\.[^.]*$/, ''), file.split('.').pop() ?? 'bin')}"`,
      )
      .header('cache-control', 'private, max-age=3600')
      .send(Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength));
  });
}
