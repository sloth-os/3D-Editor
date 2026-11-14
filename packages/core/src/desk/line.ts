import type { Vec3 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import type { ShotData } from '../doc/types';
import { findShotIndex, getDeskSettings, getShots } from './shots';
import { DeskScene } from './layout';
import { lineSide, mirrorPoint, type LinePoints } from './solver';
import { applyCameraMove, cameraHolds, viewTarget, type CameraPose } from './moves';
import { layoutView, planAgreement } from './plan';

/*
 * The 180° line (spec §6; rideo's mainPair, lineOfAction and enforceLine): the main pair's line of
 * action, the side of it the scene's cameras keep to (set by the first shot that frames both), and
 * the mirroring of cut cameras that crossed it. Orbits cross it by design and are left alone; a
 * shot's planned layout wins over the line (desk.shot_solve fits plans after enforcing the line).
 * Pair positions are read at each shot's first frame (rideo: the shot's marks). A rider and the
 * mount she sits on (desk.actor_mount) move as one, their marks a few centimetres apart: they make
 * no line, so a shot where they ride counts neither towards the main pair nor for its line.
 */

/** The scene's line: its main pair (actor ids) and the side of their line the cameras stay on. */
export interface LineOfAction {
  a: string;
  b: string;
  side: 1 | -1;
}

/** Moves that may cross the line by design. */
export const LINE_EXEMPT_MOVES: ReadonlySet<string> = new Set(['orbit_left', 'orbit_right']);

/** Whether a shot's camera move crosses the line by design (an orbit). */
export const crossesByDesign = (shot: Pick<ShotData, 'move'>): boolean =>
  !!shot.move && LINE_EXEMPT_MOVES.has(shot.move);

/** The enabled shots in cut order. */
const inCut = (shots: readonly ShotData[]) => shots.filter((s) => s.enabled);

/**
 * rideo's mainPair over shots: the two actors sharing the most shots (in cut order; the pair first
 * seen wins ties), else, with singles only, the two seen most. `isActor` picks a shot's actors out of
 * its subjects; `apart` (default: always) says whether two of them are a pair in a shot (a rider and
 * her mount are not).
 */
export function mainPairOf<S extends Pick<ShotData, 'subjects'>>(
  shots: readonly S[],
  isActor: (id: string) => boolean,
  apart: (a: string, b: string, shot: S) => boolean = () => true,
): [string, string] | null {
  const order: string[] = [];
  const together = new Map<string, number>();
  const alone = new Map<string, number>();
  for (const s of shots) {
    const cast = s.subjects.filter(isActor);
    for (const id of cast) {
      if (!order.includes(id)) order.push(id);
      alone.set(id, (alone.get(id) ?? 0) + 1);
    }
    for (let i = 0; i < cast.length; i++)
      for (let j = i + 1; j < cast.length; j++) {
        const [x, y] = [cast[i], cast[j]];
        if (!apart(x, y, s)) continue;
        const key = order.indexOf(x) <= order.indexOf(y) ? `${x}|${y}` : `${y}|${x}`;
        together.set(key, (together.get(key) ?? 0) + 1);
      }
  }
  let best: [string, string] | null = null;
  let bestCount = 0;
  for (const [key, n] of together)
    if (n > bestCount) {
      bestCount = n;
      best = key.split('|') as [string, string];
    }
  if (best) return best;
  const seen = [...order].sort((a, b) => (alone.get(b) ?? 0) - (alone.get(a) ?? 0));
  return seen.length >= 2 ? [seen[0], seen[1]] : null;
}

/** Whether two actors are a pair in a shot: neither rides the other at its first frame. */
const apartIn =
  (scene: DeskScene) =>
  (a: string, b: string, shot: Pick<ShotData, 'frame_start'>): boolean =>
    !scene.rideTogether(a, b, shot.frame_start);

/**
 * The two actors whose line of action is the 180° line: desk.main_pair when it names two actors,
 * else the pair sharing the most enabled shots (rideo's mainPair).
 */
export function mainPair(doc: SceneDoc, scene = new DeskScene(doc)): [string, string] | null {
  const set = getDeskSettings(doc).main_pair;
  if (set && scene.isActor(set[0]) && scene.isActor(set[1])) return [set[0], set[1]];
  return mainPairOf(inCut(getShots(doc)), (id) => scene.isActor(id), apartIn(scene));
}

/** The floor points of the pair at `frame`, or null when one of them is gone. */
export function pairPoints(
  scene: DeskScene,
  pair: readonly [string, string],
  frame: number,
): { a: Vec3; b: Vec3 } | null {
  const a = scene.subject(pair[0], frame);
  const b = scene.subject(pair[1], frame);
  return a && b ? { a: a.feet, b: b.feet } : null;
}

/**
 * The scene's line (rideo's lineOfAction over `shots`): the main pair (desk.main_pair, else the pair
 * these shots share most) and the side of the first of them (in cut order) that frames the pair
 * both (else either) and has a camera off the line; else the side facing the front of the set (−Y).
 * Null without a pair. `shots`: shots in cut order (default: the scene's enabled shots); a shot
 * whose camera is not placed yet counts with camera null, as rideo counts a shot it is solving.
 */
export function lineOfAction(scene: DeskScene, shots?: readonly ShotData[]): LineOfAction | null {
  const doc = scene.doc;
  const ordered = shots ?? inCut(getShots(doc));
  const set = getDeskSettings(doc).main_pair;
  const apart = apartIn(scene);
  const pair: [string, string] | null =
    set && scene.isActor(set[0]) && scene.isActor(set[1])
      ? [set[0], set[1]]
      : mainPairOf(ordered, (id) => scene.isActor(id), apart);
  if (!pair) return null;
  const both = ordered.filter((s) => pair.every((id) => s.subjects.includes(id)));
  const either = ordered.filter((s) => pair.some((id) => s.subjects.includes(id)));
  for (const s of [...both, ...either]) {
    if (!s.camera || !apart(pair[0], pair[1], s)) continue;
    const view = scene.camera(s.camera, s.frame_start);
    const pts = pairPoints(scene, pair, s.frame_start);
    if (!view || !pts) continue;
    const side = lineSide(pts.a, pts.b, view.position);
    if (side !== 0) return { a: pair[0], b: pair[1], side };
  }
  const first = ordered[0]?.frame_start ?? doc.getScene().frame_start;
  const pts = pairPoints(scene, pair, first);
  const front = pts
    ? lineSide(pts.a, pts.b, [(pts.a[0] + pts.b[0]) / 2, (pts.a[1] + pts.b[1]) / 2 - 1000, 0])
    : 1;
  return { a: pair[0], b: pair[1], side: (front || 1) as 1 | -1 };
}

/**
 * The line's floor points at `frame` with its side, for the solver; null when the pair is gone, or
 * one of them rides the other then (no line between them).
 */
export function linePointsAt(scene: DeskScene, line: LineOfAction | null, frame: number): LinePoints | null {
  if (!line || scene.rideTogether(line.a, line.b, frame)) return null;
  const pts = pairPoints(scene, [line.a, line.b], frame);
  return pts ? { ...pts, side: line.side } : null;
}

/**
 * Whether the camera of `shot` stands on the wrong side of the line at its first frame (rideo's
 * line_crossed): a cut (not an orbit) framing one of the pair, its camera off the line on the other
 * side. Never while one of the pair rides the other (no line between them).
 */
export function crossesLine(scene: DeskScene, line: LineOfAction | null, shot: ShotData): boolean {
  if (!line || !shot.camera || crossesByDesign(shot)) return false;
  if (!shot.subjects.includes(line.a) && !shot.subjects.includes(line.b)) return false;
  if (scene.rideTogether(line.a, line.b, shot.frame_start)) return false;
  const pts = pairPoints(scene, [line.a, line.b], shot.frame_start);
  const view = scene.camera(shot.camera, shot.frame_start);
  if (!pts || !view) return false;
  const side = lineSide(pts.a, pts.b, view.position);
  return side !== 0 && side !== line.side;
}

/** A camera pose mirrored across the floor line a–b (rideo's flip of a camera's position and target). */
export function mirrorPose(a: Readonly<Vec3>, b: Readonly<Vec3>, pose: CameraPose): CameraPose {
  return {
    position: mirrorPoint(a, b, pose.position),
    target: mirrorPoint(a, b, pose.target),
    lens: pose.lens,
  };
}

/**
 * Mirrors back over the line the cameras of the cuts in `shots` (ids or names; default: every enabled
 * shot) that stand on the other side at their first frame (rideo's enforceLine): the camera's pose
 * at the shot's start is mirrored across the pair's line and the shot's move keyed again from it (so
 * a dolly to the left stays a dolly to the left on screen; rideo mirrors the move's end instead).
 * Orbits are left alone. With `respectPlan` (default) a shot whose camera agrees with its planned
 * layout keeps it: the plan wins over the line. Returns the shots whose cameras were mirrored.
 */
export function enforceLine(
  doc: SceneDoc,
  shots?: readonly string[],
  o: { respectPlan?: boolean } = {},
): { mirrored: string[] } {
  const scene = new DeskScene(doc);
  const all = getShots(doc);
  const cut = inCut(all);
  const line = lineOfAction(scene, cut);
  if (!line) return { mirrored: [] };
  const wanted = shots?.length
    ? new Set(shots.map((ref) => all[findShotIndex(all, ref)]?.id).filter((id): id is string => !!id))
    : null;
  const mirrored: string[] = [];
  const shared = new Map<string, number>();
  for (const s of all) if (s.camera) shared.set(s.camera, (shared.get(s.camera) ?? 0) + 1);
  for (const s of cut) {
    if (wanted && !wanted.has(s.id)) continue;
    if (!crossesLine(scene, line, s)) continue;
    const view = scene.camera(s.camera!, s.frame_start)!;
    if (o.respectPlan !== false && s.layout.length) {
      const shown = layoutView(scene, s, s.frame_start, view);
      if (planAgreement(shown?.subjects ?? null, s.layout).agrees) continue;
    }
    const pts = pairPoints(scene, [line.a, line.b], s.frame_start)!;
    const pose = mirrorPose(pts.a, pts.b, {
      position: view.position,
      target: viewTarget(scene, view, s.subjects, s.frame_start),
      lens: view.lens,
    });
    applyCameraMove(doc, s.camera!, s.move, {
      frame_start: s.frame_start,
      frame_end: s.frame_end,
      seed: s.id,
      subjects: s.subjects,
      start: pose,
      scene,
      keyed: (shared.get(s.camera!) ?? 0) > 1,
      holds: cameraHolds(all, s.camera!, s.frame_start, s.frame_end, s.id),
    });
    mirrored.push(s.id);
  }
  return { mirrored };
}
