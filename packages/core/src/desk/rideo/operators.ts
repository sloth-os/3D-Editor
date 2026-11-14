import type { DeskAngle, DeskFacing, DeskFraming, DeskHeight, DeskMove, DeskSide } from '../../doc/types';
import type { OperatorContext } from '../../operators/context';
import type { ActorKind } from '../characters/types';
import { exportRideoBlocking, type RideoExportResult } from './export';
import { importRideoBlocking, type RideoImportResult, type ShotSolver } from './import';
import {
  RIDEO_MOVEMENTS,
  type RideoBlockingState,
  type RideoImportInput,
  type RideoMovement,
} from './schema';

/*
 * The executes of desk.import_rideo_blocking and desk.export_rideo_blocking (registered with their
 * schemas in operators/desk-shots.ts): the operator's snake_case parameters as the import's input
 * (rideo's own field names, ./schema.ts), and the warnings of both reported.
 */

/** desk.import_rideo_blocking's parameters (its zod schema's output). */
export interface ImportRideoParams {
  blocking: Record<string, unknown>;
  state?: RideoBlockingState | null;
  shots: {
    id: string;
    index: number;
    duration_s: number;
    name?: string;
    framing?: DeskFraming | null;
    angle?: DeskAngle | null;
    height?: DeskHeight | null;
    move?: DeskMove | null;
    movement?: string | null;
    lens_mm?: number | null;
    character_ids: string[];
    element_ids: string[];
    layout: { character_id: string; side: DeskSide; facing: DeskFacing }[];
    continuity: 'cut' | 'continuous';
    notes?: string;
    board_state?: string | null;
  }[];
  characters: {
    id: string;
    name: string;
    summary?: string;
    identity?: string | Record<string, string | null | undefined>;
    height_m?: number;
  }[];
  elements: { id: string; name: string; label?: string; summary?: string; kind?: string | null }[];
  settings?: { fps: number; width: number; height: number; aspect_ratio?: string | null };
  model_limits?: { min_s?: number | null; max_s?: number | null } | null;
  cast_overrides?: Record<string, ActorKind>;
  project?: string;
  clip?: string;
  pre_roll_frames: number;
  update: boolean;
}

/** Most warnings an operator run reports one by one (the result lists them all). */
const REPORTED_WARNINGS = 20;

const isMovement = (v: unknown): v is RideoMovement =>
  typeof v === 'string' && (RIDEO_MOVEMENTS as readonly string[]).includes(v);

/** The operator's parameters as the import's input. */
export function importInputOf(p: ImportRideoParams): { input: RideoImportInput; warnings: string[] } {
  const warnings: string[] = [];
  const input: RideoImportInput = {
    blocking: p.blocking,
    state: p.state ?? null,
    shots: p.shots.map((s) => {
      let movement: RideoMovement = 'static';
      if (isMovement(s.movement)) movement = s.movement;
      else if (s.movement)
        warnings.push(`shot ${s.index + 1}: unknown movement '${s.movement}' read as 'static'`);
      return {
        id: s.id,
        index: s.index,
        durationSec: s.duration_s,
        name: s.name,
        description: s.notes ?? '',
        action: '',
        camera: {
          framing: s.framing ?? 'medium',
          movement,
          lensMm: s.lens_mm ?? null,
          move: s.move ?? null,
        },
        angle: s.angle ?? null,
        height: s.height ?? null,
        characterIds: s.character_ids,
        elementIds: s.element_ids,
        layout: s.layout.map((e) => ({ characterId: e.character_id, side: e.side, facing: e.facing })),
        continuity: s.continuity,
        boardState: s.board_state ?? null,
      };
    }),
    characters: p.characters.map((c) => ({
      id: c.id,
      name: c.name,
      summary: c.summary ?? '',
      identity: c.identity,
      heightM: c.height_m ?? null,
      kind: null,
    })),
    elements: p.elements.map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind === 'location' || e.kind === 'prop' || e.kind === 'style' ? e.kind : null,
      label: e.label ?? null,
      description: e.summary ?? '',
    })),
    settings: p.settings
      ? {
          fps: p.settings.fps,
          width: p.settings.width,
          height: p.settings.height,
          aspectRatio: p.settings.aspect_ratio ?? null,
        }
      : null,
    modelLimits: p.model_limits
      ? { minSeconds: p.model_limits.min_s ?? null, maxSeconds: p.model_limits.max_s ?? null }
      : null,
    castOverrides: p.cast_overrides ?? {},
    project: p.project ?? null,
    clip: p.clip ?? null,
    preRollFrames: p.pre_roll_frames,
    update: p.update,
  };
  return { input, warnings };
}

/** desk.import_rideo_blocking: imports the clip (./import.ts) and reports its warnings. */
export function importRideoOperator(
  ctx: OperatorContext,
  p: ImportRideoParams,
  solve: ShotSolver,
): RideoImportResult {
  const { input, warnings } = importInputOf(p);
  const r = importRideoBlocking(ctx, input, solve);
  r.warnings.unshift(...warnings);
  for (const w of r.warnings.slice(0, REPORTED_WARNINGS)) ctx.report('WARNING', w);
  if (r.warnings.length > REPORTED_WARNINGS)
    ctx.report('WARNING', `${r.warnings.length - REPORTED_WARNINGS} more warnings in the result`);
  return r;
}

/** desk.export_rideo_blocking: the scene as a rideo SceneBlocking v1 (./export.ts). */
export function exportRideoOperator(ctx: OperatorContext): RideoExportResult {
  const r = exportRideoBlocking(ctx.doc);
  for (const w of r.warnings.slice(0, REPORTED_WARNINGS)) ctx.report('WARNING', w);
  return r;
}
