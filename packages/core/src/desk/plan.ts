import type { Vec3 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import type { DeskAngle, DeskFacing, DeskLayoutEntry, DeskSide, ShotData } from '../doc/types';
import { findShotIndex, getShots, setShots } from './shots';
import {
  DeskScene,
  inPicture,
  projectPoint,
  v3dot,
  v3flat,
  v3norm,
  v3sub,
  viewFromPose,
  type CameraView,
} from './layout';
import { shotSpec, type SolveSpec, type SolvedCamera } from './solver';
import {
  applyCameraMove,
  cameraHolds,
  fitShotCamera,
  fitShotCameraKeeping,
  shotFitReport,
  viewTarget,
  type CameraPose,
  type FitReport,
} from './moves';

/*
 * Plan fitting (spec §6; rideo's shotLayout, planAgreement, alignLayoutToPlan and
 * fitCameraToPlan): where a shot's subjects land on screen through its camera (rideo's frame
 * thirds at ±0.33, facings by the cosines of 35° and 70°), how that agrees with the shot's
 * planned layout, and the camera refitted to agree with it: the existing camera stays when it
 * agrees, else the first of front, both three-quarters, both profiles, back (and both
 * over-the-shoulder sides) that agrees, else the one that agrees most. The plan wins over the line.
 */

/** rideo's frame thirds: a subject projected left of −LAYOUT_THIRD is left, right of +LAYOUT_THIRD right. */
export const LAYOUT_THIRD = 0.33;
/** Facing thresholds (cosines of the angle to the camera): within 35° faces the camera, beyond 70° faces a side. */
export const FACING_COS_TOWARD = Math.cos((35 * Math.PI) / 180);
export const FACING_COS_SIDE = Math.cos((70 * Math.PI) / 180);

/** rideo's six facings on screen (the plan's four plus the three-quarter turns). */
export type ViewFacing = 'camera' | 'away' | 'left' | 'right' | 'camera_left' | 'camera_right';

/** A subject as it is on screen at one frame of a shot. */
export interface ShotLayoutEntry {
  subject: string;
  name: string;
  /** An actor (rideo's characters; the blocking line names only them). */
  actor: boolean;
  /** In the picture: x to the right and y up in [−1, 1] (NaN behind the camera). */
  x: number;
  y: number;
  /** Distance from the camera along its view axis (m); smaller is the foreground. */
  depth: number;
  in_frame: boolean;
  /** Third of the frame (centre when it cannot be projected). */
  side: DeskSide;
  /** Which way it faces on screen in the plan's words (a three-quarter turn faces the camera). */
  facing: DeskFacing;
  /** The side of a three-quarter turn (rideo's camera_left / camera_right), else null. */
  turn: 'left' | 'right' | null;
  depth_label: 'foreground' | 'background' | null;
  /** Out of frame at its edge in the foreground (the shoulder of an over-the-shoulder shot). */
  edge: 'left' | 'right' | null;
  /** Where it moves to by the end of the shot (null when it stays). */
  to: { side: DeskSide; toward: 'camera' | 'away' | null } | null;
}

/** What a shot's first frame shows (rideo's ShotLayout): its subjects, the landmarks behind them and the light. */
export interface ShotView {
  subjects: ShotLayoutEntry[];
  /** Labels of landmarks in the picture behind the subjects, nearest first (at most 3). */
  behind: string[];
  light: 'behind' | 'ahead' | 'left' | 'right';
  /** With `behind`: the side it comes from too. */
  light_side: 'left' | 'right' | null;
  interior: boolean;
}

/** How a shot's layout compares with its planned layout (rideo's PlanAgreement). */
export interface PlanAgreement {
  /** Every planned subject is in frame, on its planned side, facing the planned way, in order. */
  agrees: boolean;
  /** rideo's points: 2 a side, 1 a facing; −3 out of frame, −2 out of order (0 without a plan). */
  score: number;
  /** What disagrees, in rideo's words. */
  misses: string[];
  /** Subjects whose side, facing or order differs from the plan. */
  mismatched: string[];
}

/** rideo's six-valued facing of a layout entry. */
export const viewFacing = (e: Pick<ShotLayoutEntry, 'facing' | 'turn'>): ViewFacing =>
  e.turn ? (`camera_${e.turn}` as ViewFacing) : e.facing;

const thirdOf = (x: number): DeskSide => (x < -LAYOUT_THIRD ? 'left' : x > LAYOUT_THIRD ? 'right' : 'centre');

/**
 * What camera `view` shows of shot `shot` at `frame` (rideo's shotLayout). Moves are measured to the
 * shot's last frame through the same view. A subject put away by a hide key at `frame` (hidden) is
 * out of frame, and says nothing of where it goes. Null without a view. `subjectsOnly`: the subjects
 * alone (no landmarks behind them, no light), all a plan is judged on.
 */
export function layoutView(
  scene: DeskScene,
  shot: ShotData,
  frame: number,
  view: CameraView | null,
  o: { subjectsOnly?: boolean } = {},
): ShotView | null {
  if (!view) return null;
  const end = Math.max(frame, shot.frame_end);
  const subjects: ShotLayoutEntry[] = [];
  const hidden = new Set<string>();
  for (const id of shot.subjects) {
    const s = scene.subject(id, frame);
    if (!s) continue;
    if (s.hidden) hidden.add(id);
    // the head in a close shot, the body in a wider one: whichever of them the picture shows
    const chest = projectPoint(view, s.chest);
    const eyes = projectPoint(view, s.eyes);
    const p = inPicture(chest, 1.05) || !inPicture(eyes, 1.05) ? chest : eyes;
    const toCam = v3norm(v3flat(v3sub(view.position, s.feet)));
    const c = v3dot(s.facing, toCam);
    const sideFacing: 'left' | 'right' = v3dot(s.facing, view.right) >= 0 ? 'right' : 'left';
    let facing: DeskFacing;
    let turn: 'left' | 'right' | null = null;
    if (c > FACING_COS_TOWARD) facing = 'camera';
    else if (c < -FACING_COS_TOWARD) facing = 'away';
    else if (c > FACING_COS_SIDE) {
      facing = 'camera';
      turn = sideFacing;
    } else facing = sideFacing;
    let to: ShotLayoutEntry['to'] = null;
    if (end > frame && !s.hidden) {
      const later = scene.subject(id, end);
      if (later && !later.hidden && Math.hypot(later.feet[0] - s.feet[0], later.feet[1] - s.feet[1]) > 0.05) {
        const q = projectPoint(view, later.chest);
        const dd = Number.isFinite(q.x) ? q.depth - p.depth : 0;
        to = {
          side: Number.isFinite(q.x) ? thirdOf(q.x) : thirdOf(p.x),
          toward: Math.abs(dd) > 0.8 ? (dd < 0 ? 'camera' : 'away') : null,
        };
      }
    }
    subjects.push({
      subject: id,
      name: s.name,
      actor: s.actor,
      x: p.x,
      y: p.y,
      depth: p.depth,
      in_frame: !s.hidden && inPicture(p, 1.05),
      side: Number.isFinite(p.x) ? thirdOf(p.x) : 'centre',
      facing,
      turn,
      depth_label: null,
      edge: null,
      to,
    });
  }
  // rideo lays out characters only: the shot's actors set the depths (foreground, background), the
  // shoulder's edge and what counts as behind them; props keep their entries but move none of it
  // (a shot without actors is measured on its other subjects)
  const people = subjects.some((c) => c.actor) ? subjects.filter((c) => c.actor) : subjects;
  const visible = people.filter((c) => c.in_frame);
  const nearest = Math.min(Number.POSITIVE_INFINITY, ...visible.map((c) => c.depth));
  for (const c of subjects)
    if (
      !c.in_frame &&
      !hidden.has(c.subject) &&
      Number.isFinite(c.x) &&
      Math.abs(c.x) < 1.9 &&
      c.depth < 0.7 * nearest
    )
      c.edge = c.x < 0 ? 'left' : 'right';
  if (visible.length >= 2) {
    const depths = visible.map((c) => c.depth).sort((a, b) => a - b);
    const median = depths[Math.floor(depths.length / 2)];
    for (const c of subjects)
      if (c.in_frame)
        c.depth_label = c.depth < 0.72 * median ? 'foreground' : c.depth > 1.4 * median ? 'background' : null;
  }
  // what is behind them and where the light comes from (not needed to judge a plan)
  if (o.subjectsOnly) return { subjects, behind: [], light: 'ahead', light_side: null, interior: false };
  const far = Math.max(0, ...visible.map((c) => c.depth));
  const behind = scene
    .landmarks(frame)
    .map((l) => {
      const h = l.bounds.max[2] - l.bounds.min[2];
      const at: Vec3 = [
        (l.bounds.min[0] + l.bounds.max[0]) / 2,
        (l.bounds.min[1] + l.bounds.max[1]) / 2,
        l.bounds.min[2] + Math.min(h, 2) / 2,
      ];
      return { label: l.label, p: projectPoint(view, at) };
    })
    .filter(({ label, p }) => label && inPicture(p, 1.1) && p.depth > far + 0.5)
    .sort((a, b) => a.p.depth - b.p.depth)
    .slice(0, 3)
    .map(({ label }) => label);
  const sun = v3norm(v3flat(scene.sun(frame)), [0, 1, 0]);
  const ahead = v3dot(v3norm(v3flat(view.forward), [0, 1, 0]), sun);
  const lateral = v3dot(view.right, sun);
  const light: ShotView['light'] =
    ahead > 0.5 ? 'ahead' : ahead < -0.5 ? 'behind' : lateral >= 0 ? 'right' : 'left';
  return {
    subjects,
    behind,
    light,
    light_side: light === 'behind' && Math.abs(lateral) > 0.3 ? (lateral > 0 ? 'right' : 'left') : null,
    interior: scene.interior,
  };
}

/** The shot's camera view at `frame` (null without a camera). */
export function shotCameraView(scene: DeskScene, shot: ShotData, frame: number): CameraView | null {
  return shot.camera ? scene.camera(shot.camera, frame) : null;
}

/** Projects the shot's subjects through its camera at `frame` (rideo's thirds and facing thresholds); [] without a camera. */
export function shotLayout(doc: SceneDoc, shot: ShotData, frame: number): ShotLayoutEntry[] {
  const scene = new DeskScene(doc);
  return layoutView(scene, shot, frame, shotCameraView(scene, shot, frame))?.subjects ?? [];
}

/** Which projected facings agree with a planned one: a three-quarter turn counts for its side. */
const FACING_AGREES: Readonly<Record<DeskFacing, readonly ViewFacing[]>> = {
  left: ['left', 'camera_left'],
  right: ['right', 'camera_right'],
  camera: ['camera', 'camera_left', 'camera_right'],
  away: ['away'],
};
const SIDE_RANK: Readonly<Record<DeskSide, number>> = { left: 0, centre: 1, right: 2 };
const SAID_SIDE: Readonly<Record<DeskSide, string>> = {
  left: 'left of frame',
  centre: 'in the centre',
  right: 'right of frame',
};

/**
 * How a shot's layout agrees with its planned layout (rideo's planAgreement): each planned subject in
 * frame, on its side (one a little off centre counts for the side it leans to), facing its way (a
 * three-quarter turn counts for its side), and two subjects in their order across the frame. A shot
 * without a plan agrees; a shot without a layout (no camera) does not.
 */
export function planAgreement(
  layout: readonly ShotLayoutEntry[] | null,
  planned: readonly DeskLayoutEntry[],
  names: Readonly<Record<string, string>> = {},
): PlanAgreement {
  if (!planned.length) return { agrees: true, score: 0, misses: [], mismatched: [] };
  if (!layout)
    return {
      agrees: false,
      score: -100,
      misses: ['the shot has no camera'],
      mismatched: planned.map((p) => p.subject),
    };
  const name = (id: string) => names[id] ?? layout.find((c) => c.subject === id)?.name ?? 'A subject';
  let score = 0;
  const misses: string[] = [];
  const mismatched = new Set<string>();
  const placed: { p: DeskLayoutEntry; c: ShotLayoutEntry }[] = [];
  for (const p of planned) {
    const c = layout.find((x) => x.subject === p.subject);
    if (!c?.in_frame) {
      score -= 3;
      misses.push(`${name(p.subject)} is out of frame`);
      mismatched.add(p.subject);
      continue;
    }
    placed.push({ p, c });
    const leans = c.side === 'centre' && ((p.side === 'left' && c.x < 0) || (p.side === 'right' && c.x > 0));
    if (p.side === c.side || leans) score += 2;
    else {
      misses.push(`${name(p.subject)} is ${SAID_SIDE[c.side]}, not ${SAID_SIDE[p.side]}`);
      mismatched.add(p.subject);
    }
    const f = viewFacing(c);
    if (FACING_AGREES[p.facing].includes(f)) score += 1;
    else {
      misses.push(`${name(p.subject)} faces ${f.replace('_', ' ')}, not ${p.facing}`);
      mismatched.add(p.subject);
    }
  }
  for (const a of placed)
    for (const b of placed)
      if (SIDE_RANK[a.p.side] < SIDE_RANK[b.p.side] && !(a.c.x < b.c.x)) {
        score -= 2;
        misses.push(`${name(a.p.subject)} is not left of ${name(b.p.subject)}`);
        mismatched.add(a.p.subject);
        mismatched.add(b.p.subject);
      }
  return { agrees: misses.length === 0, score, misses, mismatched: [...mismatched] };
}

/**
 * A layout in the plan's words where the camera agrees with it (rideo's alignLayoutToPlan): a subject
 * a little off centre on the side the plan puts it is said to be on that side.
 */
export function alignLayoutToPlan(
  layout: readonly ShotLayoutEntry[],
  planned: readonly DeskLayoutEntry[],
): ShotLayoutEntry[] {
  if (!planned.length) return [...layout];
  return layout.map((c) => {
    const p = planned.find((x) => x.subject === c.subject);
    const leans =
      p &&
      c.in_frame &&
      c.side === 'centre' &&
      ((p.side === 'left' && c.x < 0) || (p.side === 'right' && c.x > 0));
    return leans ? { ...c, side: p.side } : c;
  });
}

/** The directions the fit tries around a shot's subjects, after the shot's own camera. */
export const FIT_ANGLES: readonly DeskAngle[] = [
  'front',
  'three_quarter_left',
  'three_quarter_right',
  'profile_left',
  'profile_right',
  'back',
];

/** The outcome of fitting a shot's camera to its plan. */
export interface PlanFit {
  /** The agreement of the camera kept (the shot's own or the refitted one). */
  agreement: PlanAgreement;
  /** The agreement of the shot's own camera. */
  own: PlanAgreement;
  /** The spec of the refitted camera (null: the own camera stays). */
  spec: SolveSpec | null;
  /** The refitted camera and how it frames the shot (null: the own camera stays). */
  solved: (SolvedCamera & FitReport) | null;
  /** The camera kept holds every subject in frame at the frames desk.check samples. */
  in_frame: boolean;
  /** Some camera tried agrees with the plan (one kept, or one given up because it loses a subject). */
  agreeing: boolean;
}

/**
 * Fits a shot's camera to its plan at `frame` (rideo's fitCameraToPlan), without writing anything:
 * the own camera when it agrees, else the first candidate that agrees and keeps the shot's subjects
 * in frame, else the one that keeps them in frame (the in-frame fit wins over the plan: a subject out
 * of frame is an error, a plan mismatch a warning), then the one that agrees, then the one that agrees
 * most (if better than the own). Candidates: over-the-shoulder from both shoulders first when the
 * shot is one, then front, three-quarters, profiles and back around its subjects; each fitted over
 * the shot from `frame` (moves.ts fitShotCamera, within its framing limit) and, when that disagrees,
 * kept at the composition of its first frame and backed off along it to keep the subjects in frame
 * (fitShotCameraKeeping: the plan kept and the subjects too, at the price of a wider frame). Beyond
 * rideo, a shot that is not an over-the-shoulder with two or more actors then tries both shoulders
 * too, taken only when one agrees with the plan outright: a wide or medium shot never becomes a
 * shoulder shot that still disagrees (rideo keeps the best of its standard angles). Solved without the
 * line. `pose`: the own camera's start (default: where it stands at `frame`, looking at its subjects).
 * Null without a plan.
 */
export function planFit(
  scene: DeskScene,
  shot: ShotData,
  index: number,
  o: { frame?: number; lens?: number | null; pose?: CameraPose } = {},
): PlanFit | null {
  const plan = shot.layout;
  if (!plan.length) return null;
  const frame = o.frame ?? shot.frame_start;
  const evaluate = (view: CameraView | null) =>
    planAgreement(layoutView(scene, shot, frame, view, { subjectsOnly: true })?.subjects ?? null, plan);
  const ownView = shotCameraView(scene, shot, frame);
  const own = evaluate(ownView);
  const base = shotSpec(scene, shot, index, o.lens);
  const span = { frame_start: frame, frame_end: Math.max(frame, shot.frame_end) };
  // whether the own camera keeps the subjects in frame through the shot's move
  const ownPose: CameraPose | null =
    o.pose ??
    (ownView && {
      position: ownView.position,
      target: viewTarget(scene, ownView, shot.subjects, frame),
      lens: ownView.lens,
    });
  const ownInFrame = ownPose
    ? shotFitReport(scene, { ...base, lens_mm: ownPose.lens }, span, ownPose).out_of_frame.length === 0
    : false;
  if (own.agrees)
    return { agreement: own, own, spec: null, solved: null, in_frame: ownInFrame, agreeing: true };
  const actors = base.subjects.filter((id) => scene.isActor(id));
  const shoulders = (): SolveSpec[] => {
    if (actors.length < 2) return [];
    const [a, b] = actors;
    const rest = base.subjects.filter((id) => id !== a && id !== b);
    return [
      { ...base, angle: 'over_shoulder', subjects: [a, b, ...rest] },
      { ...base, angle: 'over_shoulder', subjects: [b, a, ...rest] },
    ];
  };
  const specs: { spec: SolveSpec; onlyIfAgrees: boolean }[] = [];
  const shoulderShot = base.angle === 'over_shoulder';
  if (shoulderShot) for (const spec of shoulders()) specs.push({ spec, onlyIfAgrees: false });
  for (const angle of FIT_ANGLES)
    specs.push({ spec: { ...base, angle, subjects: [...base.subjects] }, onlyIfAgrees: false });
  if (!shoulderShot) for (const spec of shoulders()) specs.push({ spec, onlyIfAgrees: true });
  // the camera kept: in frame first, then agreeing, then by rideo's points (the own camera on a tie)
  const rank = (f: PlanFit): number[] => [f.in_frame ? 1 : 0, f.agreement.agrees ? 1 : 0, f.agreement.score];
  const better = (a: PlanFit, b: PlanFit): boolean => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] > rb[i];
    return false;
  };
  const agreesView = (view: CameraView) => evaluate(view).agrees;
  let best: PlanFit = {
    agreement: own,
    own,
    spec: null,
    solved: null,
    in_frame: ownInFrame,
    agreeing: false,
  };
  let agreeing = false;
  for (const { spec, onlyIfAgrees } of specs) {
    const options: (SolvedCamera & FitReport)[] = [fitShotCamera(scene, spec, span)];
    for (let i = 0; i < options.length; i++) {
      const solved = options[i];
      const agreement = evaluate(viewFromPose(solved.position, solved.target, solved.lens_mm, scene.aspect));
      const fit: PlanFit = {
        agreement,
        own,
        spec,
        solved,
        in_frame: solved.out_of_frame.length === 0,
        agreeing: true,
      };
      if (agreement.agrees && fit.in_frame) return fit;
      agreeing ||= agreement.agrees;
      // its first frame's composition kept, backed off along it to keep the subjects in frame
      if (i === 0 && !agreement.agrees) {
        const kept = fitShotCameraKeeping(scene, spec, span, agreesView);
        if (kept) options.push(kept);
      }
      if ((!onlyIfAgrees || agreement.agrees) && better(fit, best)) best = fit;
    }
  }
  return { ...best, agreeing };
}

/**
 * Refits the shot's camera to its planned layout ({@link planFit}): tries front, both three-quarters,
 * both profiles, back and both over-the-shoulder sides and keeps the camera that agrees best (the
 * existing camera stays when it agrees; a shoulder camera only when it agrees). A refitted camera is
 * posed at the shot's start with its move keyed again, and the shot's angle (and the order of its
 * subjects for an over-the-shoulder) follows it.
 */
export function fitShotToPlan(
  doc: SceneDoc,
  shot: ShotData,
  o: { frame?: number } = {},
): { changed: boolean; agreement: PlanAgreement } {
  const scene = new DeskScene(doc);
  const shots = getShots(doc);
  const index = Math.max(0, findShotIndex(shots, shot.id));
  const fit = planFit(scene, shot, index, o);
  if (!fit) return { changed: false, agreement: planAgreement([], []) };
  if (!fit.spec || !fit.solved || !shot.camera) return { changed: false, agreement: fit.agreement };
  const holds = cameraHolds(shots, shot.camera, shot.frame_start, shot.frame_end, shot.id);
  applyCameraMove(doc, shot.camera, shot.move, {
    frame_start: shot.frame_start,
    frame_end: shot.frame_end,
    seed: shot.id,
    subjects: fit.spec.subjects,
    start: { position: fit.solved.position, target: fit.solved.target, lens: fit.solved.lens_mm },
    scene,
    keyed: shots.some((x) => x.id !== shot.id && x.camera === shot.camera),
    holds,
  });
  const i = findShotIndex(shots, shot.id);
  if (i >= 0) {
    shots[i] = { ...shots[i], angle: fit.spec.angle, subjects: fit.spec.subjects };
    setShots(doc, shots);
  }
  return { changed: true, agreement: fit.agreement };
}
