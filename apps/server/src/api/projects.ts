import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ExportFormat } from '@3d-editor/core';
import type { RoomManager } from '../sync/room-manager';
import { StorageUnavailableError } from '../sync/room-manager';
import { ProjectMemoryError } from '../sync/project-memory';
import {
  ProjectNameTakenError,
  freeProjectName,
  requireFreeProjectName,
  withProjectNames,
} from '../sync/project-names';
import type { Room } from '../sync/room';
import { errorMessage, withSpan, withSpanSync } from '../observability/tracing';
import { RenderRequestError, isCancelled, isOutOfMemory, sharedRenderer, type Renderer } from '../render';
import { sharedRenderStore, type RenderStore } from '../render/store';
import { snapshotRefusal } from '../render/memory';
import { badRequest } from './errors';

export const EXPORT_FORMATS = ['glb', 'gltf', 'obj', 'stl', 'ply'] as const;

/** Name of projects created without one (then 'Untitled.001', … while it is taken). */
const UNTITLED = 'Untitled';
const createBody = z.object({
  /** Must not be taken (ignoring case); without it the first free 'Untitled', 'Untitled.001' … */
  name: z.string().trim().min(1).max(200).optional(),
  empty: z.boolean().default(false),
});
const renameBody = z.object({ name: z.string().trim().min(1).max(200) });
const idParams = z.object({ id: z.string() });
/**
 * Options of GET /api/projects/:id/export (the same as the MCP export_scene tool, whose download
 * link carries them): `objects` (comma-separated ids or names; default every object shown in
 * renders), `apply_modifiers` (default true), `frame` (default the scene's frame_start) and
 * `bake_resolution` (glTF: pixels of procedural texture bakes, 64–4096; default per mesh).
 */
const exportQuery = z.object({
  format: z.enum(EXPORT_FORMATS).default('glb'),
  objects: z.string().optional(),
  apply_modifiers: z
    .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
    .transform((v) => ['true', '1', 'yes', 'on'].includes(v))
    .optional(),
  frame: z.coerce.number().optional(),
  bake_resolution: z.coerce.number().int().min(64).max(4096).optional(),
});
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

/**
 * 409 for a name another project has: its id and what to do. Project names are unique (ignoring
 * letter case) because projects are found by name (MCP tools, `?project=` links).
 */
function nameTaken(reply: FastifyReply, err: ProjectNameTakenError) {
  const ids = err.ids;
  return reply.code(409).send({
    error:
      `A project named '${err.holders[0].name}' already exists (id ${ids.join(', ')}). Project names are unique, ignoring letter case, ` +
      `because projects are found by name: open that project, delete it first (DELETE /api/projects/${ids[0]}) or choose another name.`,
    id: ids[0],
    ids,
  });
}

/**
 * The reply of a render or export that ran out of memory (render.png, export): 507 Insufficient
 * Storage with code OUT_OF_MEMORY (the scene needs more memory than a render process has: retrying
 * does not help), or 503 with code INTERRUPTED and Retry-After when another render that shared the
 * render process ran it out of memory (this one can run again). Null for other errors.
 */
export function outOfMemoryReply(
  err: unknown,
  what: 'render' | 'export',
): { status: number; body: { error: string; code: string }; retryAfter?: number } | null {
  if (!isOutOfMemory(err)) return null;
  const error = `${what} failed: ${err.message}`;
  return err.reason === 'shared'
    ? { status: 503, body: { error, code: 'INTERRUPTED' }, retryAfter: 1 }
    : { status: 507, body: { error, code: 'OUT_OF_MEMORY' } };
}

function sendOutOfMemory(reply: FastifyReply, r: NonNullable<ReturnType<typeof outOfMemoryReply>>) {
  if (r.retryAfter !== undefined) reply.header('retry-after', String(r.retryAfter));
  return reply.code(r.status).send(r.body);
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
  /** Renders in progress (path traced ones may take minutes): cancelled when the server stops. */
  const rendering = new Set<AbortController>();
  app.addHook('preClose', async () => {
    for (const abort of rendering) abort.abort();
  });

  /**
   * Loads a project or replies 404/503, or 507 with code OUT_OF_MEMORY for a stored project the
   * server cannot load (RoomManager logged it: 'project not loaded: the server cannot hold it').
   */
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
      if (err instanceof ProjectMemoryError) {
        await reply.code(507).send({ error: err.message, code: 'OUT_OF_MEMORY' });
        return null;
      }
      throw err;
    }
  }

  app.get('/api/projects', async () => ({ projects: await rooms.listProjects() }));

  app.post('/api/projects', async (request, reply) => {
    const body = createBody.safeParse(request.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    const { name, empty } = body.data;
    try {
      // the name check and the creation run one at a time with MCP create_project / rename_project
      const room = await withProjectNames(rooms, async () => {
        if (name !== undefined) await requireFreeProjectName(rooms, name);
        return rooms.createProject({ name: name ?? (await freeProjectName(rooms, UNTITLED)), empty });
      });
      return reply.code(201).send({ id: room.id, name: room.scene.name });
    } catch (err) {
      if (err instanceof ProjectNameTakenError) return nameTaken(reply, err);
      throw err;
    }
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
    try {
      await withProjectNames(rooms, async () => {
        await requireFreeProjectName(rooms, body.data.name, id);
        room.scene.setName(body.data.name);
      });
    } catch (err) {
      if (err instanceof ProjectNameTakenError) return nameTaken(reply, err);
      throw err;
    }
    return room.listing();
  });

  app.delete('/api/projects/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    let deleted: boolean;
    try {
      deleted = await rooms.deleteProject(id);
    } catch (err) {
      // storage could not delete the project, or tell whether it exists: 503 with the reason, like
      // the GET routes (RoomManager logged it: 'deleting project failed')
      if (err instanceof StorageUnavailableError) return reply.code(503).send({ error: err.message });
      throw err;
    }
    if (!deleted) return reply.code(404).send({ error: `project '${id}' not found` });
    renderStore.forgetProject(id);
    return reply.code(204).send();
  });

  app.get('/api/projects/:id/snapshot', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const room = await roomOr404(id, reply);
    if (!room) return reply;
    // the copy of the meshes and its JSON take the server's own heap (render/memory.ts)
    const refused = snapshotRefusal(room.scene);
    if (refused)
      return sendOutOfMemory(reply, {
        status: 507,
        body: { error: `snapshot failed: ${refused}`, code: 'OUT_OF_MEMORY' },
      });
    return withSpanSync('project.snapshot', { 'project.id': id }, () => room.scene.toSnapshot());
  });

  app.get('/api/projects/:id/export', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const q = exportQuery.safeParse(request.query);
    if (!q.success)
      return badRequest(
        reply,
        q.error.issues.some((i) => i.path[0] === 'format')
          ? `format must be one of ${EXPORT_FORMATS.join(', ')}`
          : q.error,
      );
    const room = await roomOr404(id, reply);
    if (!room) return reply;
    let objectIds: string[] | undefined;
    if (q.data.objects !== undefined) {
      const refs = q.data.objects
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean);
      const missing = refs.filter((r) => !room.scene.resolveObject(r));
      if (missing.length) return reply.code(400).send({ error: `objects not found: ${missing.join(', ')}` });
      objectIds = refs.map((r) => room.scene.resolveObject(r)!.id);
    }
    // a client that goes away cancels the export, and so does a server shutdown
    const abort = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) abort.abort();
    };
    reply.raw.once('close', onClose);
    rendering.add(abort);
    try {
      // on a render thread (exports of large animated scenes take seconds: not on the event loop)
      const result = await withSpan(
        'project.export',
        { 'project.id': id, 'export.format': q.data.format },
        () =>
          renderer().exportScene({
            scene: room.scene,
            projectId: id,
            format: q.data.format as ExportFormat,
            options: {
              objectIds,
              applyModifiers: q.data.apply_modifiers,
              frame: q.data.frame,
              bakeResolution: q.data.bake_resolution,
            },
            signal: abort.signal,
          }),
      );
      return reply
        .header('content-type', result.mime)
        .header(
          'content-disposition',
          `attachment; filename="${safeFileName(room.scene.name, result.extension)}"`,
        )
        .header('cache-control', 'no-store')
        .header('x-export-time-ms', String(result.elapsedMs))
        .send(Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength));
    } catch (err) {
      if (isCancelled(err))
        return reply
          .code(abort.signal.aborted && reply.raw.writable ? 503 : 499)
          .send({ error: 'export cancelled' });
      if (isNotImplemented(err)) return reply.code(501).send({ error: errorMessage(err) });
      const oom = outOfMemoryReply(err, 'export');
      if (oom) return sendOutOfMemory(reply, oom);
      return reply.code(500).send({ error: `export failed: ${errorMessage(err)}` });
    } finally {
      rendering.delete(abort);
      reply.raw.off('close', onClose);
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
    // a client that goes away cancels its render, and so does a server shutdown
    const abort = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) abort.abort();
    };
    reply.raw.once('close', onClose);
    rendering.add(abort);
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
      if (isCancelled(err))
        return reply
          .code(abort.signal.aborted && reply.raw.writable ? 503 : 499)
          .send({ error: 'render cancelled' });
      if (err instanceof RenderRequestError) return reply.code(400).send({ error: err.message });
      if (isNotImplemented(err)) return reply.code(501).send({ error: errorMessage(err) });
      const oom = outOfMemoryReply(err, 'render');
      if (oom) return sendOutOfMemory(reply, oom);
      return reply.code(500).send({ error: `render failed: ${errorMessage(err)}` });
    } finally {
      rendering.delete(abort);
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
