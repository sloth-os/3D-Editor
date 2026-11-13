import type { SceneDoc } from '../doc/scene-doc';
import type { DeskMove } from '../doc/types';
import { OperatorError } from '../operators/context';

/*
 * Camera moves keyed over a shot's range (DESK-CORE; spec §6): push/pull/dolly/crane BEZIER, orbit
 * ≥ 8 keys on the arc, pans and tilts rotation only, whip_pan, handheld NOISE (seeded by the shot
 * id), dolly_zoom, drone_flyover, rack_focus, and tracking_follow / steadicam_walk following the
 * first subject. FOUNDATION wrote the name; it throws until DESK-CORE implements it.
 */

export function applyCameraMove(
  _doc: SceneDoc,
  _cameraId: string,
  _move: DeskMove,
  _o: { frame_start: number; frame_end: number; amount?: number; seed?: string; subject?: string },
): { keyframes: number } {
  throw new OperatorError('applyCameraMove is not implemented yet', 'FAILED');
}
