import type { SceneDoc } from '../doc/scene-doc';
import { OperatorError } from '../operators/context';

/*
 * The set of a scene (DESK-CORE; spec §4 desk.set_build, §1 sun): a ground plane coloured from the
 * ground's name (rideo's table), a SKY world whose sun is rideo's (sun_rotation = rad(azimuth) + π,
 * sun_elevation = rad(elevation); the one key light), and walls for interiors. FOUNDATION wrote the
 * name; it throws until DESK-CORE implements it.
 */

export interface DeskSetOptions {
  width: number;
  depth: number;
  ground: string;
  interior: boolean;
  /** rideo's azimuth: 0° = front (towards the audience), 90° = right. */
  sun_azimuth_deg: number;
  sun_elevation_deg: number;
  sky: boolean;
}

export function buildSet(_doc: SceneDoc, _o: DeskSetOptions): { ground: string; walls: string[] } {
  throw new OperatorError('buildSet is not implemented yet', 'FAILED');
}
