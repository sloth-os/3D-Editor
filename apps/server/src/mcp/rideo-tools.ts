import { z } from 'zod';
import { ACTOR_KINDS } from '@3d-editor/core';
import { importTarget, type ProjectAccess } from '../rideo';
import type { ProjectRunner } from '../rideo/import';
import { rideoIdSchema, rideoProjectIdSchema } from '../rideo/schemas';
import { REFERENCE_MODES } from '../rideo/shots';
import { ProjectNameTakenError, requireFreeProjectName, withProjectNames } from '../sync/project-names';
import { PASS_NAMES } from '../video/params';
import { NotFoundError, ToolError, type AgentProject } from './agent';
import { EDIT, projectArg, strictArgObject, type ToolContext, type ToolRegistrar } from './tool-kit';

/*
 * The rideo bridge tools (SPEC §11): rideo_import (a rideo clip's blocking into a project, one undo
 * step of the agent) and rideo_push (the project's staging back to rideo, an export's clips as the
 * shots' reference videos). The handlers read ctx.rideo when they run (registration reads nothing
 * of ctx).
 */

const rideoArg = strictArgObject({
  url: z.string().min(1).max(2000).optional().describe("rideo's base URL (default: the server's RIDEO_URL)"),
  token: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe('rideo API or agent token (default: RIDEO_TOKEN, which is only sent to RIDEO_URL)'),
  project: rideoProjectIdSchema.describe('rideo project id (prj_…)'),
  clip: rideoIdSchema.describe('rideo clip id (clp_…): the scene'),
}).describe('The rideo clip');

/** The video model's duration limits, when rideo's own (its /api/config) are not the ones to use. */
export const modelLimitsArg = strictArgObject({
  min_s: z.number().positive().max(3600).describe("The video model's shortest take in seconds"),
  max_s: z.number().positive().max(3600).describe("The video model's longest take in seconds"),
})
  .optional()
  .describe("The video model's duration limits (default: rideo's, from its /api/config)");

/** The agent's project as the bridge runs operators in it (each run one undo step). */
function agentRunner(p: AgentProject): ProjectRunner {
  return {
    id: p.id,
    get doc() {
      return p.scene;
    },
    run: (operator, params) => p.step(() => p.run(operator, params)),
  };
}

/** Projects as the agent finds them (id or name) and new empty ones it then holds. */
function agentAccess(ctx: ToolContext): ProjectAccess {
  return {
    find: async (ref) => {
      try {
        const p = await ctx.agent.project(ref);
        return { runner: agentRunner(p), name: p.scene.name };
      } catch (err) {
        if (err instanceof NotFoundError) return null;
        throw err;
      }
    },
    create: async (name) => {
      const room = await withProjectNames(ctx.rooms, async () => {
        try {
          await requireFreeProjectName(ctx.rooms, name);
        } catch (err) {
          if (err instanceof ProjectNameTakenError)
            throw new ToolError(`${err.message}: pass project to import into it`, 'INVALID_PARAMS');
          throw err;
        }
        return ctx.rooms.createProject({ name, empty: true });
      });
      const p = await ctx.agent.project(room.id);
      return { runner: agentRunner(p), name: p.scene.name };
    },
  };
}

export function registerRideoTools(tool: ToolRegistrar, ctx: ToolContext): void {
  tool(
    'rideo_import',
    {
      title: 'Import rideo clip',
      description:
        "Build or update a project from a rideo clip (scene) as one undo step: rideo's fps and size, its shots in order with their cameras, layout and moves, the cast at their marks, props and landmarks. Without project, the project is named after the clip (made when missing). Importing again rebuilds the imported actors, props, landmarks and shot cameras from rideo's blocking; warnings name those changed here since the last import (push first, or stage them again). Returns our project id, our shot id per rideo shot, issues and warnings (no blocking yet, rideo's desk off, boards to redraw).",
      annotations: { ...EDIT, openWorldHint: true },
    },
    {
      project: projectArg.optional().describe('Our project (id or name; made with this name when missing)'),
      rideo: rideoArg,
      use_store_models: z
        .boolean()
        .optional()
        .describe('Props and landmarks as built-in store models (default: as the importer chooses)'),
      cast_overrides: z
        .record(z.string(), z.enum(ACTOR_KINDS))
        .optional()
        .describe('Actor kind by rideo character id, e.g. {"chr_…": "pony"} (default: inferred)'),
      model_limits: modelLimitsArg,
    },
    async ({ project, rideo, use_store_models, cast_overrides, model_limits }, extra) => {
      const { docs, url } = await ctx.rideo.readClip(rideo, extra.signal);
      const target = await importTarget(agentAccess(ctx), project, docs);
      return {
        ...ctx.rideo.importClip(target, docs, { url, cast_overrides, use_store_models, model_limits }),
      };
    },
  );

  tool(
    'rideo_push',
    {
      title: 'Push export to rideo',
      description:
        "Send the clips of an export made with export_video {preset: 'rideo'} as reference videos of their rideo shots. First writes our blocking to the rideo clip (write_blocking; refused for an approved clip), then per shot (default: physics, tethers, held props or a camera move) checks frames, fps and size, uploads its clip of the mode's pass (motion beauty, pose pose, camera depth; none: the shot fails) and sets motionReference with the camera move. Mode: camera when rideo's first frame cannot follow our staging, else motion (props in motion) or pose (actors); a 'performance' reference stays.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    {
      project: projectArg,
      export: z.string().min(1).describe('Video export id (export_video), finished'),
      rideo: rideoArg,
      shots: z
        .array(z.string().min(1))
        .min(1)
        .max(512)
        .optional()
        .describe('Shots to push (our ids or names, or rideo shot ids; default: see the description)'),
      mode: z
        .enum(REFERENCE_MODES)
        .optional()
        .describe('Reference mode for every shot pushed (default: per shot, see the description)'),
      pass: z
        .enum(PASS_NAMES)
        .optional()
        .describe(
          "Pass to send for every shot (default per mode: motion beauty, pose pose, camera depth; the export's clip of it, or the shot fails)",
        ),
      write_blocking: z
        .boolean()
        .default(true)
        .describe("Write our blocking to the rideo clip first, so rideo's view and line follow the clips"),
    },
    async ({ project, export: exportId, rideo, shots, mode, pass, write_blocking }, extra) => {
      const p = await ctx.agent.project(project);
      const result = await ctx.rideo.push(
        agentRunner(p),
        { export: exportId, rideo, shots, mode, pass, write_blocking },
        extra.signal,
      );
      return { ...result };
    },
  );
}
