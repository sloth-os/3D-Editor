import { z } from 'zod';
import {
  SceneBriefSchema,
  briefProblems,
  briefRecord,
  type SceneBrief,
  type ShotResultMeta,
  type StageBriefReport,
} from '@3d-editor/core';
import type { RunResult } from '@3d-editor/core';
import { ProjectNameTakenError, requireFreeProjectName, withProjectNames } from '../sync/project-names';
import { ToolError, type AgentProject } from './agent';
import { EDIT, READ_ONLY, projectArg, type ToolContext, type ToolRegistrar } from './tool-kit';

/*
 * The brief tools (the desk embed protocol v1's SceneBrief, for agents that hold a host's scene):
 * desk_stage_brief stages a brief in a project, or brings a project staged from the same scene up to
 * it (one undo step of the agent each), and desk_shot_results reports each staged shot's frames,
 * camera, blocking line, moves, plan and checks. The renders a host wants are export_video's
 * (preset 'reference'). Handlers read ctx when they run (registration reads nothing of it). A project
 * desk_stage_brief made for a brief that then fails to stage (refused for memory, or any other
 * failure) is deleted again, so that its name stays free for the next try.
 */

/** Most characters of a project name made from a brief's name. */
const MAX_PROJECT_NAME = 120;

/** The brief, validated as the contract has it (INVALID_PARAMS naming its first problems). */
function parseBrief(raw: unknown): SceneBrief {
  const r = SceneBriefSchema.safeParse(raw);
  if (!r.success) throw new ToolError(`invalid brief: ${briefProblems(r.error)}`, 'INVALID_PARAMS');
  return r.data;
}

/** Runs operator `id` in project `p` as one undo step; its failure as a ToolError with the operator's code. */
function runStep<T>(p: AgentProject, id: string, params: unknown): T {
  const res: RunResult<T> = p.step(() => p.run<T>(id, params));
  if (!res.ok) throw new ToolError(res.error ?? `${id} failed`, res.code ?? 'FAILED');
  return res.result as T;
}

/** A new empty project named after the brief, held by the agent (INVALID_PARAMS when the name is taken). */
async function createProject(ctx: ToolContext, brief: SceneBrief): Promise<AgentProject> {
  const name = brief.name.trim().slice(0, MAX_PROJECT_NAME) || brief.id;
  const room = await withProjectNames(ctx.rooms, async () => {
    try {
      await requireFreeProjectName(ctx.rooms, name);
    } catch (err) {
      if (err instanceof ProjectNameTakenError)
        throw new ToolError(`${err.message}: pass project to stage the brief in it`, 'INVALID_PARAMS');
      throw err;
    }
    return ctx.rooms.createProject({ name, empty: true });
  });
  return ctx.agent.project(room.id);
}

/**
 * Deletes project `p`, made by this call for a brief that then failed to stage with `err`, and
 * returns the error to throw: `err` itself, or (when storage did not delete the project) `err` naming
 * the project left behind.
 */
async function dropMadeProject(ctx: ToolContext, p: AgentProject, err: unknown): Promise<unknown> {
  const name = p.scene.name;
  try {
    const deleted = await withProjectNames(ctx.rooms, () => ctx.rooms.deleteProject(p.id));
    if (deleted) {
      ctx.agent.forget(p.id);
      return err;
    }
  } catch {
    // storage refused the deletion: the project stays, and the error names it
  }
  if (!(err instanceof ToolError)) return err;
  return new ToolError(
    `${err.message} (the project '${name}' (${p.id}) made for the brief stays: pass it as project to stage the brief in it, or delete it)`,
    err.code,
  );
}

export function registerBriefTools(tool: ToolRegistrar, ctx: ToolContext): void {
  tool(
    'desk_stage_brief',
    {
      title: 'Stage brief',
      description:
        "Stage a host's scene brief (desk embed protocol v1 SceneBrief: fps, size, set, cast, elements, shots) as one undo step: the set and its sun, the cast as actors, the props, a shot per brief shot (round(durationSec × fps) frames, the host's ids kept) with its camera solved from its framing and fitted to its planned layout. Without project, a new project named after the brief (deleted again when the staging fails). A project staged from the same scene is updated instead, keeping what is unchanged (cameras and actors moved by hand too); one staged from another scene, or holding shots of its own, is refused. Returns the project, the shots (host id → desk shot, frames), changes, warnings and issues; render with export_video {preset: 'reference'}.",
      annotations: EDIT,
    },
    {
      project: projectArg
        .optional()
        .describe('Project (id or name) to stage in or update (default: a new one named after the brief)'),
      brief: z
        .record(z.string(), z.unknown())
        .describe("The host's SceneBrief (validated whole: the contract's limits and id pattern)"),
    },
    async ({ project, brief: raw }) => {
      const brief = parseBrief(raw);
      const p = project ? await ctx.agent.project(project) : await createProject(ctx, brief);
      const staged = briefRecord(p.scene);
      if (staged && staged.sceneId !== brief.id)
        throw new ToolError(
          `project '${p.scene.name}' is staged from scene '${staged.sceneId}', not '${brief.id}': stage this brief in another project (omit project)`,
          'INVALID_PARAMS',
        );
      const action = staged ? 'updated' : 'staged';
      let r: StageBriefReport;
      try {
        r = runStep<StageBriefReport>(p, staged ? 'desk.update_from_brief' : 'desk.stage_brief', { brief });
      } catch (err) {
        // a project made for this brief goes with the failure: its name stays free for a retry
        throw project ? err : await dropMadeProject(ctx, p, err);
      }
      return {
        project: { id: p.id, name: p.scene.name },
        action,
        scene_id: r.sceneId,
        hash: r.hash,
        shots: r.shots,
        cast: r.cast,
        props: r.props,
        changes: r.changes,
        solved: r.solved,
        warnings: r.warnings,
        issues: r.issues,
      };
    },
  );

  tool(
    'desk_shot_results',
    {
      title: 'Shot results',
      description:
        "Each shot of a project staged from a brief (desk_stage_brief), in brief order: frames and duration at the brief's fps (as an export at that rate counts them), the staged camera's lens (integer mm) and move, where everyone stands and faces through the camera at its first frame, who walks where, whether the camera shows the planned layout (null without one) and the desk's checks (errors and warnings). Read-only.",
      annotations: READ_ONLY,
    },
    {
      project: projectArg,
      shots: z
        .array(z.string().min(1).max(100))
        .min(1)
        .max(200)
        .optional()
        .describe("The host's shot ids (default: every staged shot)"),
    },
    async ({ project, shots }) => {
      const p = await ctx.agent.project(project);
      const res = p.run<{ shots: ShotResultMeta[] }>('desk.shot_results', shots ? { shots } : {});
      if (!res.ok) throw new ToolError(res.error ?? 'desk.shot_results failed', res.code ?? 'FAILED');
      return { project: { id: p.id, name: p.scene.name }, shots: res.result!.shots };
    },
  );
}
