import type { Vec3 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import type { DeskAngle, DeskFraming, ShotData } from '../doc/types';
import { OperatorError } from '../operators/context';

/*
 * The camera solver (DESK-CORE; spec §6): rideo's solveCamera reproduced in editor axes (Z up,
 * front −Y). FOUNDATION wrote rideo's tables (report-agent6 §2) and the names; solveShotCamera
 * throws until DESK-CORE implements it.
 */

/** Horizontal sensor width the desk's cameras use (mm; sensor_fit HORIZONTAL). */
export const DESK_SENSOR_WIDTH_MM = 36;

export interface FramingSpec {
  /** Height of the subject the frame covers (m, for a 1.7 m subject). */
  coverage_m: number;
  /** Default lens (mm). */
  lens_mm: number;
  /** Share of the tallest subject's height the camera aims at. */
  look: number;
}

/** rideo's framing table: coverage / default lens / look-at share. */
export const FRAMING_TABLE: Readonly<Record<DeskFraming, FramingSpec>> = {
  extreme_wide: { coverage_m: 10, lens_mm: 18, look: 0.5 },
  wide: { coverage_m: 4.2, lens_mm: 24, look: 0.5 },
  medium: { coverage_m: 1.25, lens_mm: 35, look: 0.72 },
  medium_close: { coverage_m: 0.85, lens_mm: 50, look: 0.8 },
  close_up: { coverage_m: 0.45, lens_mm: 85, look: 0.92 },
  extreme_close_up: { coverage_m: 0.22, lens_mm: 100, look: 0.93 },
  over_shoulder: { coverage_m: 1.1, lens_mm: 50, look: 0.88 },
  pov: { coverage_m: 2.5, lens_mm: 28, look: 0.9 },
  insert: { coverage_m: 0.35, lens_mm: 85, look: 0.55 },
};

/**
 * rideo's ANGLE_DEG: the camera's turn around the subjects from their front (degrees; positive
 * turns to the subject's left). Over-the-shoulder and POV are placed by their own rules.
 */
export const ANGLE_DEG: Readonly<Partial<Record<DeskAngle, number>>> = {
  front: 0,
  three_quarter_left: 35,
  three_quarter_right: -35,
  profile_left: 90,
  profile_right: -90,
  back: 180,
};

/** A solved camera: where it stands and looks, its lens, and where its move ends (null: no move). */
export interface SolvedCamera {
  position: Vec3;
  target: Vec3;
  lens_mm: number;
  end: { position: Vec3; target: Vec3 } | null;
}

/** Solves the shot's camera from its framing, angle, height, subjects and lens at `frame` (default: frame_start). */
export function solveShotCamera(
  _doc: SceneDoc,
  _shot: ShotData,
  _o?: { frame?: number; aspect?: number },
): SolvedCamera {
  throw new OperatorError('solveShotCamera is not implemented yet', 'FAILED');
}
