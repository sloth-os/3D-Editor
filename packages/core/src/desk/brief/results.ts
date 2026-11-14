import type { SceneDoc } from '../../doc/scene-doc';
import { OperatorError } from '../../operators/context';
import { blockingLine, blockingMoves, checkShots } from '../checks';
import { DeskScene } from '../layout';
import { layoutView, planAgreement } from '../plan';
import { readBriefRecord } from './record';
import type { Move } from './schema';
import { hostShots } from './stage';

/*
 * shotResults: what the desk tells a host about each staged shot besides its files (the contract's
 * ShotResult without `references` and `still`, which an export adds): its frames and duration at the
 * scene's frame rate, the staged camera's lens and move, where everyone stands and faces through the
 * camera at the shot's first frame (the blocking line), who walks where during it, whether the camera
 * shows the planned layout, and the desk's checks of it (errors and warnings; notes left out).
 *
 * Pure core: no DOM, no Node API, so it runs in a web worker as well as on the server.
 */

/** A shot's result as the contract's ShotResult has it, without the files of an export. */
export interface ShotResultMeta {
  /** The host's shot id. */
  shotId: string;
  /** The desk's shot id. */
  deskShotId: string;
  frames: number;
  /** frames / fps. */
  durationSec: number;
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

const clampLens = (mm: number) => Math.min(800, Math.max(8, Math.round(mm)));

/**
 * The results of the shots of `doc` staged from a brief (stageBrief), in brief order; `shots` (host
 * shot ids) narrows them, in the order given. Throws an OperatorError: INVALID_PARAMS for a project
 * not staged from a brief, NOT_FOUND for a shot id the staged brief does not have (or whose desk shot
 * was deleted).
 */
export function shotResults(doc: SceneDoc, opts: { shots?: readonly string[] } = {}): ShotResultMeta[] {
  const record = readBriefRecord(doc);
  if (!record)
    throw new OperatorError(
      'the project is not staged from a brief: stage one first (stageBrief)',
      'INVALID_PARAMS',
    );
  const desk = hostShots(doc, record.sceneId);
  const ids = opts.shots?.length
    ? [...new Set(opts.shots)]
    : record.shots.map((s) => s.id).filter((id) => desk.has(id));
  for (const id of ids)
    if (!desk.has(id))
      throw new OperatorError(
        `shot '${id}' is not a shot of the brief staged in the project (scene '${record.sceneId}')`,
        'NOT_FOUND',
      );
  const shots = ids.map((id) => desk.get(id)!);
  const fps = Math.max(1, doc.getScene().fps || 24);
  const scene = new DeskScene(doc);
  const issues = shots.length ? checkShots(doc, { shots: shots.map((s) => s.id) }).issues : [];
  return ids.map((id, k) => {
    const s = shots[k];
    const frames = s.frame_end - s.frame_start + 1;
    const view = s.camera ? scene.camera(s.camera, s.frame_start) : null;
    const moves = blockingMoves(doc, s, scene);
    return {
      shotId: id,
      deskShotId: s.id,
      frames,
      durationSec: frames / fps,
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
}
