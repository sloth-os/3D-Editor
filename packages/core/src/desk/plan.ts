import type { SceneDoc } from '../doc/scene-doc';
import type { DeskFacing, DeskLayoutEntry, DeskSide, ShotData } from '../doc/types';
import { OperatorError } from '../operators/context';

/*
 * Plan fitting (DESK-CORE; spec §6): where a shot's subjects land on screen, how far that agrees
 * with the shot's planned layout (rideo's PlannedPlacement), and the camera of the shot refitted to
 * agree with it. FOUNDATION wrote the names and rideo's thresholds; the functions throw until
 * DESK-CORE implements them.
 */

/** rideo's frame thirds: a subject projected left of −LAYOUT_THIRD is left, right of +LAYOUT_THIRD right. */
export const LAYOUT_THIRD = 0.33;
/** Facing thresholds (cosines of the angle to the camera): within 35° faces the camera, beyond 70° faces a side. */
export const FACING_COS_TOWARD = Math.cos((35 * Math.PI) / 180);
export const FACING_COS_SIDE = Math.cos((70 * Math.PI) / 180);

/** A subject as it is on screen at one frame of a shot. */
export interface ShotLayoutEntry {
  subject: string;
  side: DeskSide;
  facing: DeskFacing;
  /** Distance from the camera along its view axis (m); smaller is the foreground. */
  depth: number;
}

/** How a shot's layout compares with its plan. */
export interface PlanAgreement {
  /** Every planned subject is on its planned side, facing the planned way. */
  agrees: boolean;
  /** Share of planned entries the layout matches, 0–1 (1 when there is no plan). */
  score: number;
  /** Subjects whose side or facing differs from the plan. */
  mismatched: string[];
}

function notImplemented(name: string): never {
  throw new OperatorError(`${name} is not implemented yet`, 'FAILED');
}

/** Projects the shot's subjects through its camera at `frame` (rideo's thirds and facing thresholds). */
export function shotLayout(_doc: SceneDoc, _shot: ShotData, _frame: number): ShotLayoutEntry[] {
  return notImplemented('shotLayout');
}

/** Compares a shot's layout with its planned layout. */
export function planAgreement(
  _layout: readonly ShotLayoutEntry[],
  _planned: readonly DeskLayoutEntry[],
): PlanAgreement {
  return notImplemented('planAgreement');
}

/**
 * Refits the shot's camera to its planned layout: tries front, both three-quarters, both profiles,
 * back and both over-the-shoulder sides and keeps the camera that agrees best (the existing camera
 * stays when it agrees).
 */
export function fitShotToPlan(
  _doc: SceneDoc,
  _shot: ShotData,
  _o?: { frame?: number },
): { changed: boolean; agreement: PlanAgreement } {
  return notImplemented('fitShotToPlan');
}
