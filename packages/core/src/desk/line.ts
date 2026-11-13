import type { SceneDoc } from '../doc/scene-doc';
import { OperatorError } from '../operators/context';

/*
 * The 180° line (DESK-CORE; spec §6): the main pair's line of action and the mirroring of cut
 * cameras that cross it (orbits exempt; a shot's plan wins over the line). FOUNDATION wrote the
 * names; the functions throw until DESK-CORE implements them.
 */

/** The two actors whose line of action is the 180° line (desk.main_pair, else the pair sharing most shots). */
export function mainPair(_doc: SceneDoc): [string, string] | null {
  throw new OperatorError('mainPair is not implemented yet', 'FAILED');
}

/** Mirrors the cameras of `shots` (ids; default: all) that cross the line; returns the shots changed. */
export function enforceLine(_doc: SceneDoc, _shots?: readonly string[]): { mirrored: string[] } {
  throw new OperatorError('enforceLine is not implemented yet', 'FAILED');
}
