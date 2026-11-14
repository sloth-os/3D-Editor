import type { SceneDoc } from '../../doc/scene-doc';
import { OperatorError } from '../../operators/context';
import { blockingLine, blockingMoves, checkShots } from '../checks';
import { DeskScene } from '../layout';
import { layoutView, planAgreement } from '../plan';
import { shotOutputFrames } from '../shots';
import { readBriefRecord } from './record';
import type { Move } from './schema';
import { hostShots } from './stage';

/*
 * shotResults: what the desk tells a host about each staged shot besides its files (the contract's
 * ShotResult without `references` and `still`, which an export adds): its frames and duration at the
 * brief's frame rate, counted as an export at that rate plans them (core's planExport: the shot's
 * scene frames resampled from the scene's rate), the staged camera's lens and move, where everyone
 * stands and faces through the camera at the shot's first frame (the blocking line), who walks where
 * during it, whether the camera shows the planned layout, and the desk's checks of it (errors and
 * warnings; notes left out). The shots come in brief order, whatever order they are asked in.
 *
 * Pure core: no DOM, no Node API, so it runs in a web worker as well as on the server.
 */

/** A shot's result as the contract's ShotResult has it, without the files of an export. */
export interface ShotResultMeta {
  /** The host's shot id. */
  shotId: string;
  /** The desk's shot id. */
  deskShotId: string;
  /**
   * The frames of the shot's clips at the brief's frame rate (or the `fps` asked): its scene frames
   * resampled as an export plans them, max(1, round(sceneFrames × fps / sceneFps)).
   */
  frames: number;
  /** frames / fps. */
  durationSec: number;
  /** The shot's frames in the scene (frame_end − frame_start + 1), at the scene's frame rate. */
  sceneFrames: number;
  /** The scene's frame rate. */
  sceneFps: number;
  /** The staged camera at the shot's first frame: its lens rounded to an integer 8–800, and the shot's move. */
  camera: { lensMm: number; move: Move | null };
  /** Where everyone stands and faces, in words, through the shot's camera at its first frame. */
  line: string;
  /** Who walks where during the shot, in words (null: nobody moves). */
  moves: string | null;
  /** Whether the camera shows the shot's planned layout (null: the shot has none). */
  planAgrees: boolean | null;
  issues: { code: string; severity: 'error' | 'warning'; message: string }[];
}

export interface ShotResultsOptions {
  /** The host's shot ids to report (default: every staged shot); the results keep brief order. */
  shots?: readonly string[];
  /** The frame rate the frames and durations are counted at (default: the brief's, as staged). */
  fps?: number;
}

const clampLens = (mm: number) => Math.min(800, Math.max(8, Math.round(mm)));

/** The scene's frame rate as an export reads it (core's planExport). */
const sceneRate = (fps: number): number => (fps > 0 && Number.isFinite(fps) ? fps : 24);

/** Output frames of `sceneFrames` scene frames at another rate, as planExport counts them (at least 1). */
export const outputFramesAt = (sceneFrames: number, sceneFps: number, fps: number): number =>
  Math.max(1, Math.round((sceneFrames * fps) / sceneFps));

/**
 * The results of the shots of `doc` staged from a brief (stageBrief), in brief order, and the asked
 * shots that have none: the ids the staged brief does not have, or whose desk shot was deleted
 * (`missing`, in the order asked). Throws an OperatorError (INVALID_PARAMS) for a project not staged
 * from a brief.
 */
export function shotResultsOf(
  doc: SceneDoc,
  opts: ShotResultsOptions = {},
): { results: ShotResultMeta[]; missing: string[] } {
  const record = readBriefRecord(doc);
  if (!record)
    throw new OperatorError(
      'the project is not staged from a brief: stage one first (stageBrief)',
      'INVALID_PARAMS',
    );
  const desk = hostShots(doc, record.sceneId);
  const order = record.shots.map((s) => s.id);
  const asked = opts.shots?.length ? new Set(opts.shots) : null;
  const ids = order.filter((id) => desk.has(id) && (!asked || asked.has(id)));
  const missing = asked ? [...asked].filter((id) => !ids.includes(id)) : [];
  const shots = ids.map((id) => desk.get(id)!);
  const sceneFps = sceneRate(doc.getScene().fps);
  const fps = opts.fps !== undefined && opts.fps > 0 ? opts.fps : sceneRate(record.fps);
  const scene = new DeskScene(doc);
  const issues = shots.length ? checkShots(doc, { shots: shots.map((s) => s.id) }).issues : [];
  const results = ids.map((id, k): ShotResultMeta => {
    const s = shots[k];
    const sceneFrames = shotOutputFrames(s);
    const frames = outputFramesAt(sceneFrames, sceneFps, fps);
    const view = s.camera ? scene.camera(s.camera, s.frame_start) : null;
    const moves = blockingMoves(doc, s, scene);
    return {
      shotId: id,
      deskShotId: s.id,
      frames,
      durationSec: frames / fps,
      sceneFrames,
      sceneFps,
      camera: { lensMm: clampLens(view?.lens ?? s.lens_mm ?? 50), move: s.move },
      line: blockingLine(doc, s, s.frame_start, scene),
      moves: moves || null,
      planAgrees: s.layout.length
        ? planAgreement(layoutView(scene, s, s.frame_start, view)?.subjects ?? null, s.layout).agrees
        : null,
      issues: issues
        .filter((i) => i.shot === s.id && i.severity !== 'info')
        .map((i) => ({ code: i.code, severity: i.severity as 'error' | 'warning', message: i.message })),
    };
  });
  return { results, missing };
}

/**
 * The results of the shots of `doc` staged from a brief (see shotResultsOf), in brief order;
 * `shots` (host shot ids) narrows them. Throws an OperatorError: INVALID_PARAMS for a project not
 * staged from a brief, NOT_FOUND naming every asked shot the staged brief does not have (or whose desk
 * shot was deleted).
 */
export function shotResults(doc: SceneDoc, opts: ShotResultsOptions = {}): ShotResultMeta[] {
  const { results, missing } = shotResultsOf(doc, opts);
  if (missing.length) {
    const sceneId = readBriefRecord(doc)!.sceneId;
    throw new OperatorError(
      `${missing.length === 1 ? 'shot' : 'shots'} ${missing.map((id) => `'${id}'`).join(', ')} ${
        missing.length === 1 ? 'is not a shot' : 'are not shots'
      } of the brief staged in the project (scene '${sceneId}')`,
      'NOT_FOUND',
    );
  }
  return results;
}
