import type { SceneDoc } from '../doc/scene-doc';
import type { ShotData } from '../doc/types';
import { OperatorError } from '../operators/context';
import type { ShotLayoutEntry } from './plan';

/*
 * Continuity checks and rideo's blocking sentences (DESK-CORE; spec §7). FOUNDATION wrote the issue
 * codes, their severities and the names; the functions throw until DESK-CORE implements them.
 */

export const DESK_ISSUE_CODES = [
  'line_crossed',
  'subject_out_of_frame',
  'camera_inside',
  'missing_camera',
  'plan_mismatch',
  'screen_direction',
  'jump_cut',
  'absent_in_frame',
  'actors_overlap',
  'outside_set',
  'empty_shot',
  'duration_clamped',
  'physics_unbaked',
  'shot_gap',
] as const;
export type DeskIssueCode = (typeof DESK_ISSUE_CODES)[number];

export type DeskIssueSeverity = 'error' | 'warning' | 'info';

/** The severity of each issue code (spec §7). */
export const DESK_ISSUE_SEVERITY: Readonly<Record<DeskIssueCode, DeskIssueSeverity>> = {
  line_crossed: 'error',
  subject_out_of_frame: 'error',
  camera_inside: 'error',
  missing_camera: 'error',
  plan_mismatch: 'warning',
  screen_direction: 'warning',
  jump_cut: 'warning',
  absent_in_frame: 'warning',
  actors_overlap: 'warning',
  outside_set: 'warning',
  empty_shot: 'warning',
  duration_clamped: 'warning',
  physics_unbaked: 'info',
  shot_gap: 'info',
};

export interface DeskIssue {
  code: DeskIssueCode;
  severity: DeskIssueSeverity;
  /** The shot's id (null: the whole scene). */
  shot: string | null;
  /** Object ids involved. */
  objects: string[];
  message: string;
}

/** What desk.check returns. */
export interface DeskCheckResult {
  issues: DeskIssue[];
  /** rideo's blocking sentence of each shot's first frame. */
  lines: { shot: string; line: string }[];
  /** Each shot's layout at its first frame. */
  layouts: { shot: string; layout: ShotLayoutEntry[] }[];
  summary: string;
}

function notImplemented(name: string): never {
  throw new OperatorError(`${name} is not implemented yet`, 'FAILED');
}

/** Runs the continuity checks over `shots` (ids; default: every shot). */
export function checkShots(_doc: SceneDoc, _o?: { shots?: readonly string[] }): DeskCheckResult {
  return notImplemented('checkShots');
}

/**
 * rideo's blocking sentence for the shot at `frame`, e.g. "Blocking: Ada is left of frame in the
 * foreground, facing right; Ben is right of frame, facing the camera. Behind them: the lake.
 * Light: the sun is behind the camera, on the left."
 */
export function blockingLine(_doc: SceneDoc, _shot: ShotData, _frame: number): string {
  return notImplemented('blockingLine');
}

/** rideo's moves sentence for the shot, e.g. "Ada walks from left of frame to the centre." */
export function blockingMoves(_doc: SceneDoc, _shot: ShotData): string {
  return notImplemented('blockingMoves');
}
