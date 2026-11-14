import { z } from 'zod';
import { stageBriefIn, type StageBriefReport } from '../desk/brief/stage';
import { updateFromBriefIn } from '../desk/brief/update';
import { shotResults, type ShotResultMeta } from '../desk/brief/results';
import { MAX_PRE_ROLL } from '../desk/shots';
import type { OperatorContext } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { pollObjectMode } from './helpers';

/*
 * Brief operators of the director's desk (desk/brief; the desk embed protocol v1's SceneBrief):
 *
 *   desk.stage_brief        a host's brief staged in an empty project (one undo step)
 *   desk.update_from_brief  the staging brought up to a later brief of the same scene (one undo step)
 *   desk.shot_results       each staged shot's frames, camera, blocking line, moves, plan and checks (read-only)
 *
 * The brief is passed whole and validated by SceneBriefSchema (INVALID_PARAMS names its first problems).
 */

/** Most warnings an operator run reports one by one (the result lists them all). */
const REPORTED_WARNINGS = 20;

const BRIEF_PARAM = z
  .record(z.string(), z.unknown())
  .describe(
    "The host's SceneBrief (desk embed protocol v1): id, name, fps, width, height, set {description, interior, " +
      'timeOfDay}, cast[], elements[], shots[] (validated whole; the shots keep their ids)',
  );

function reportWarnings(ctx: OperatorContext, r: StageBriefReport): StageBriefReport {
  for (const w of r.warnings.slice(0, REPORTED_WARNINGS)) ctx.report('WARNING', w);
  if (r.warnings.length > REPORTED_WARNINGS)
    ctx.report('WARNING', `${r.warnings.length - REPORTED_WARNINGS} more warnings in the result`);
  return r;
}

export function registerDeskBriefOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'desk.stage_brief',
      label: 'Stage Brief',
      poll: pollObjectMode,
      description:
        "Stages a host's scene brief in a project without shots: the frame rate and size, the set (ground, sun " +
        'from the time of day, water the words name), the cast as actors, the props (held ones in the hand that ' +
        "the shots' words give them), a shot per brief shot with its camera solved from its framing and fitted " +
        'to its planned layout, the cast not in a shot hidden in it, and the checks. Returns the shots (host id → ' +
        'desk shot), cast, props, warnings and issues.',
      category: 'Desk',
      schema: z.object({
        brief: BRIEF_PARAM,
        pre_roll_frames: z
          .number()
          .int()
          .min(0)
          .max(MAX_PRE_ROLL)
          .default(12)
          .describe('Frames of the gap before a cut where marks jump (animated, never exported)'),
      }),
      execute: (ctx, p) =>
        reportWarnings(ctx, stageBriefIn(ctx, p.brief, { preRollFrames: p.pre_roll_frames })),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.update_from_brief',
      label: 'Update from Brief',
      poll: pollObjectMode,
      description:
        'Brings a project staged from a brief up to a later brief of the same scene, keeping the staging of ' +
        'unchanged shots (cameras and actors moved by hand too): removed shots go, retimed ones grow or shrink ' +
        'at their end, new ones are staged after the shot before them and solved, recast ones show their new ' +
        'cast; later shots move with their frames. Returns what changed, the shots and warnings.',
      category: 'Desk',
      schema: z.object({ brief: BRIEF_PARAM }),
      execute: (ctx, p) => reportWarnings(ctx, updateFromBriefIn(ctx, p.brief)),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.shot_results',
      label: 'Shot Results',
      description:
        "Each shot staged from the project's brief (read-only): its frames and duration, the camera's lens and " +
        'move, where everyone stands and faces through the camera at its first frame, who walks where, whether ' +
        "the camera shows the planned layout, and the desk's checks. Returns {shots}.",
      category: 'Desk',
      undo: false,
      schema: z.object({
        shots: z
          .array(z.string().min(1).max(100))
          .max(200)
          .optional()
          .describe(
            "The host's shot ids to report, in this order (default: every staged shot in brief order)",
          ),
      }),
      execute: (ctx, p): { shots: ShotResultMeta[] } => ({ shots: shotResults(ctx.doc, { shots: p.shots }) }),
    }),
  );
}
