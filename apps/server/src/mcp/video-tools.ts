import { z } from 'zod';
import { MAX_EXPORT_WAIT_S, videoExportParamsShape } from '../video/params';
import { DESTRUCTIVE, EDIT, READ_ONLY, projectArg, type ToolContext, type ToolRegistrar } from './tool-kit';

/*
 * The video export tools (SPEC §9): an export is a background job (start, then poll), because a
 * film takes minutes and MCP clients time out after 60 s. The handlers read ctx.exports when they
 * run (registration reads nothing of ctx).
 */

const exportArg = z.string().min(1).describe('Export id (from export_video or list_exports)');

export function registerVideoTools(tool: ToolRegistrar, ctx: ToolContext): void {
  tool(
    'export_video',
    {
      title: 'Export video',
      description:
        "Start a video export of the project's shots (or of its frame range) on the server: rendered in the background and encoded with ffmpeg into an MP4 of the whole sequence, one frame-exact clip per shot, posters, a contact sheet, a manifest and optional control passes (depth, normal, mask, edges, pose). Returns at once with the export id, frames_total and estimate_s: follow it with export_status (wait_s waits), stop it with cancel_export. Fails with FFMPEG_UNAVAILABLE without ffmpeg and QUEUE_FULL when too many exports wait.",
      annotations: EDIT,
    },
    { project: projectArg, ...videoExportParamsShape },
    async ({ project, ...params }) => {
      const job = await ctx.exports.start(project, params);
      return {
        export: job.id,
        status: job.status,
        frames_total: job.progress.frames_total,
        estimate_s: job.progress.eta_s,
      };
    },
  );

  tool(
    'export_status',
    {
      title: 'Video export status',
      description:
        'The state of a video export: status (queued, running, encoding, done, failed or cancelled), progress (frames done of frames_total, fps, eta_s, the shot being rendered), warnings, the error of a failed one and, when done, its files with download links (sequence, clips, posters, manifest, passes). wait_s waits up to that many seconds for the export to finish or move on before answering.',
      annotations: READ_ONLY,
    },
    {
      export: exportArg,
      wait_s: z
        .number()
        .min(0)
        .max(MAX_EXPORT_WAIT_S)
        .optional()
        .describe(
          `Wait up to this many seconds (0–${MAX_EXPORT_WAIT_S}) for the export to finish or progress`,
        ),
    },
    async (a, extra) => ({
      ...(await ctx.exports.status(a.export, { waitS: a.wait_s, signal: extra.signal })),
    }),
  );

  tool(
    'cancel_export',
    {
      title: 'Cancel video export',
      description:
        'Cancel a queued or running video export (a finished one is kept). delete_files also deletes the export and every file it wrote.',
      annotations: DESTRUCTIVE,
    },
    {
      export: exportArg,
      delete_files: z.boolean().default(false).describe('Also delete the export and its files'),
    },
    async (a) => ({ ...(await ctx.exports.cancel(a.export, { deleteFiles: a.delete_files })) }),
  );

  tool(
    'list_exports',
    {
      title: 'List video exports',
      description:
        'The video exports of a project (or of every project), newest first: id, status, progress, label and files.',
      annotations: READ_ONLY,
    },
    { project: projectArg.optional() },
    async (a) => ({ exports: await ctx.exports.list(a.project) }),
  );
}
