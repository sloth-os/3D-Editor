import { z } from 'zod';
import type { Vec3 } from '../math/types';
import type {
  DeskAngle,
  DeskFacing,
  DeskFraming,
  DeskHeight,
  DeskLayoutEntry,
  DeskMove,
  DeskSide,
  ShotData,
} from '../doc/types';
import {
  DESK_ANGLES,
  DESK_CONTINUITIES,
  DESK_FACINGS,
  DESK_FRAMINGS,
  DESK_HEIGHTS,
  DESK_MOVES,
  DESK_SIDES,
} from '../doc/types';
import { ACTOR_KINDS } from '../desk/characters';
import {
  MAX_PRE_ROLL,
  MAX_SHOT_FRAME,
  MAX_SHOT_LAYOUT,
  MAX_SHOT_NAME,
  MAX_SHOT_NOTES,
  MAX_SHOT_SECONDS,
  MAX_SHOT_SUBJECTS,
  MAX_SHOTS,
  SHOT_LENS_MAX,
  SHOT_LENS_MIN,
  findShotIndex,
  getShots,
  newShotId,
  setShots,
} from '../desk/shots';
import { DESK_PROPS } from '../desk/props';
import { DeskScene, deskProp } from '../desk/layout';
import { DEFAULT_FRAMING, FRAMING_TABLE, MAX_WIDEN, shotSpec, type SolveSpec } from '../desk/solver';
import { crossesLine, lineOfAction, linePointsAt, mirrorPose, pairPoints } from '../desk/line';
import {
  addDeskCamera,
  applyCameraMove,
  cameraHolds,
  fitShotCamera,
  keepShotInFrame,
  prepareDeskCamera,
  retimeCameraRange,
  shotFitLosses,
  shotFitReport,
  shotOcclusions,
  type CameraPose,
  type FitReport,
  type Occlusion,
} from '../desk/moves';
import { planFit } from '../desk/plan';
import { checkShots, type DeskIssue } from '../desk/checks';
import { buildSet } from '../desk/set';
import { exportRideoOperator, importRideoOperator } from '../desk/rideo/operators';
import type { OperatorContext } from './context';
import { OperatorError } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { pollObjectMode, setSelection, vec3 } from './helpers';

/*
 * Shot operators of the director's desk (DESK-CORE owns this module; spec §4–§7, §11):
 *
 *   desk.shot_add                 add a shot (and its camera), solved from its framing
 *   desk.shot_update              change a shot (solving its camera again when asked)
 *   desk.shot_remove              remove shots (and their cameras)
 *   desk.shot_move                move a shot in the cut
 *   desk.shot_solve               solve shots' cameras (plan fitting, moves, the 180° line)
 *   desk.check                    continuity checks, blocking lines and layouts (read-only)
 *   desk.set_build                ground, sky and sun (and interior walls) of the set
 *   desk.camera_move              key a camera move over a shot or a range
 *   desk.import_rideo_blocking    a rideo clip's SceneBlocking as a scene and shots
 *   desk.export_rideo_blocking    the scene as a rideo SceneBlocking v1 (read-only)
 *
 * Shots live in SceneSettings.shots and are read and written only through desk/shots.ts; the camera
 * work is desk/solver.ts, line.ts, plan.ts and moves.ts, the checks desk/checks.ts, the set
 * desk/set.ts, the rideo import and export desk/rideo/.
 * Axes: Z up, the front is −Y (rideo +z), facings in degrees about +Z with 0 facing the front.
 */

const framingEnum = z
  .enum(DESK_FRAMINGS)
  .describe(
    'Framing: extreme_wide, wide, medium, medium_close, close_up, extreme_close_up, over_shoulder, pov or insert ' +
      '(how much of the subjects the frame holds; rideo camera.framing)',
  );
const angleEnum = z
  .enum(DESK_ANGLES)
  .describe(
    'Camera angle around the subjects: front, three_quarter_left/right (±35°), profile_left/right (±90°), back, ' +
      'over_shoulder or pov',
  );
const heightEnum = z
  .enum(DESK_HEIGHTS)
  .describe('Camera height: eye, low, high (1.2 m above the head) or overhead (4 m above the head)');
const moveEnum = z
  .enum(DESK_MOVES)
  .describe(
    'Camera move over the shot (rideo move ids): locked_off, push_in, pull_out, dolly_left/right, pan_left/right, ' +
      'tilt_up/down, tracking_follow, steadicam_walk, orbit_left/right, crane_up/down, whip_pan, handheld, ' +
      'dolly_zoom, drone_flyover or rack_focus',
  );
const lensSchema = z
  .number()
  .min(SHOT_LENS_MIN)
  .max(SHOT_LENS_MAX)
  .describe(
    `Lens focal length in mm on a 36 mm wide sensor, ${SHOT_LENS_MIN}–${SHOT_LENS_MAX} (default: the framing's)`,
  );
const subjectsSchema = z
  .array(z.string().describe('Object id or exact name'))
  .max(MAX_SHOT_SUBJECTS)
  .describe(`The shot's subjects (actors or props), at most ${MAX_SHOT_SUBJECTS}; the first leads`);
const layoutSchema = z
  .array(
    z.object({
      subject: z.string().describe('Object id or exact name of one of the subjects'),
      side: z.enum(DESK_SIDES).describe('Third of the frame the subject is in: left, centre or right'),
      facing: z
        .enum(DESK_FACINGS)
        .describe('Which way the subject faces on screen: left, right, camera or away'),
    }),
  )
  .max(MAX_SHOT_LAYOUT)
  .describe(
    'Planned screen layout, one entry per subject (rideo shot.layout): the solve keeps the camera whose view agrees ' +
      'with it (front, three-quarters, profiles, back, over the shoulder); plan_mismatch when none does',
  );
const notesSchema = z
  .string()
  .max(MAX_SHOT_NOTES)
  .describe(`Notes (description, action), at most ${MAX_SHOT_NOTES} characters`);
const continuitySchema = z
  .enum(DESK_CONTINUITIES)
  .describe(
    "How the shot follows the one before: 'cut', or 'continuous' (the action carries on; no jump of marks)",
  );
const preRollSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_PRE_ROLL)
  .describe(
    'Frames before frame_start that are animated and simulated but never exported, so holds and physics settle',
  );
const frameStartSchema = z.number().int().describe('First scene frame of the shot');
const frameEndSchema = z
  .number()
  .int()
  .describe('Last scene frame of the shot (inclusive; at least frame_start)');
const durationSchema = z
  .number()
  .positive()
  .max(MAX_SHOT_SECONDS)
  .describe('Length in seconds at the scene frame rate, when frame_end is not given');
const shotRef = z.string().describe('Shot id or exact name');
const shotRefs = z.array(shotRef).describe('Shot ids or exact names (default: every enabled shot)');

// ---------------------------------------------------------------- shared

/** Default length of a new shot (seconds). */
export const DEFAULT_SHOT_SECONDS = 5;

const fpsOf = (ctx: OperatorContext): number => Math.max(1, ctx.doc.getScene().fps || 24);

/** The object `ref` names (an id or an exact name), or NOT_FOUND. */
function objectRef(ctx: OperatorContext, ref: string): string {
  const id = (ctx.doc.getObject(ref) ?? ctx.doc.resolveObject(ref))?.id;
  if (!id) throw new OperatorError(`Object '${ref}' not found`, 'NOT_FOUND');
  return id;
}

/** The CAMERA object `ref` names; NOT_FOUND, or INVALID_PARAMS when it is not a camera. */
function cameraRef(ctx: OperatorContext, ref: string): string {
  const id = objectRef(ctx, ref);
  if (ctx.doc.getObject(id)?.type !== 'CAMERA')
    throw new OperatorError(`'${ref}' is not a camera object`, 'INVALID_PARAMS');
  return id;
}

/** The index of the shot `ref` names (an id or an exact name) in `shots`, or NOT_FOUND. */
function shotRefIndex(shots: readonly ShotData[], ref: string): number {
  const i = findShotIndex(shots, ref);
  if (i < 0) throw new OperatorError(`Shot '${ref}' not found`, 'NOT_FOUND');
  return i;
}

interface LayoutParam {
  subject: string;
  side: DeskSide;
  facing: DeskFacing;
}

/**
 * Subjects and planned layout resolved to object ids (each once); a planned subject the subjects
 * leave out is added to them. INVALID_PARAMS beyond MAX_SHOT_SUBJECTS.
 */
function castOf(
  ctx: OperatorContext,
  subjects: readonly string[] | undefined,
  layout: readonly LayoutParam[] | undefined,
  base: { subjects: string[]; layout: DeskLayoutEntry[] },
): { subjects: string[]; layout: DeskLayoutEntry[] } {
  const ids = subjects ? [...new Set(subjects.map((r) => objectRef(ctx, r)))] : [...base.subjects];
  let plan = base.layout;
  if (layout) {
    const seen = new Set<string>();
    plan = [];
    for (const e of layout) {
      const subject = objectRef(ctx, e.subject);
      if (seen.has(subject)) continue;
      seen.add(subject);
      plan.push({ subject, side: e.side, facing: e.facing });
    }
  }
  for (const e of plan) if (!ids.includes(e.subject)) ids.push(e.subject);
  if (ids.length > MAX_SHOT_SUBJECTS)
    throw new OperatorError(
      `A shot has at most ${MAX_SHOT_SUBJECTS} subjects (${ids.length} given)`,
      'INVALID_PARAMS',
    );
  return { subjects: ids, layout: plan };
}

/** "Shot <n>" not taken by a shot of `shots`. */
function freeShotName(shots: readonly ShotData[]): string {
  const taken = new Set(shots.map((s) => s.name));
  for (let n = shots.length + 1; ; n++) if (!taken.has(`Shot ${n}`)) return `Shot ${n}`;
}

/** Makes the scene long enough for a shot ending at `frameEnd`. */
function extendScene(ctx: OperatorContext, frameEnd: number): void {
  if (frameEnd > ctx.doc.getScene().frame_end) ctx.doc.updateScene({ frame_end: frameEnd });
}

/** How many shots use each camera. */
function cameraUse(shots: readonly ShotData[]): Map<string, number> {
  const use = new Map<string, number>();
  for (const s of shots) if (s.camera) use.set(s.camera, (use.get(s.camera) ?? 0) + 1);
  return use;
}

/**
 * Refuses a shot over [start, end] on camera `cameraId` that would overlap another shot using the
 * same camera: a camera shows one view at a time, and keying one shot would replace the other's
 * keys over the overlap.
 */
function refuseCameraOverlap(
  shots: readonly ShotData[],
  shot: Pick<ShotData, 'id' | 'name'>,
  cameraId: string | null,
  start: number,
  end: number,
  cameraName: string,
): void {
  if (!cameraId) return;
  const other = shots.find(
    (x) => x.id !== shot.id && x.camera === cameraId && x.frame_start <= end && x.frame_end >= start,
  );
  if (other)
    throw new OperatorError(
      `Shot '${shot.name}' (frames ${start}–${end}) would overlap shot '${other.name}' (frames ` +
        `${other.frame_start}–${other.frame_end}), which shoots with the same camera '${cameraName}': a camera ` +
        'shows one view at a time. Give one of them another camera or another range',
      'INVALID_PARAMS',
    );
}

/**
 * Writes a shot's camera pose at its start (null: where the camera stands, its roll kept) and keys
 * its move from there; the other shots on the camera keep their views.
 */
function poseShot(
  ctx: OperatorContext,
  shot: ShotData,
  pose: CameraPose | null,
  shared: boolean,
  move: DeskMove | null,
  scene?: DeskScene,
) {
  prepareDeskCamera(ctx.doc, shot.camera!, shot.id);
  return applyCameraMove(ctx.doc, shot.camera!, move, {
    frame_start: shot.frame_start,
    frame_end: shot.frame_end,
    seed: shot.id,
    subjects: shot.subjects,
    start: pose ?? undefined,
    scene,
    keyed: shared,
    holds: cameraHolds(getShots(ctx.doc), shot.camera!, shot.frame_start, shot.frame_end, shot.id),
  });
}

/** What solving a shot came to. */
export interface SolvedShot extends FitReport {
  id: string;
  name: string;
  camera: string;
  angle: DeskAngle;
  /** The camera was added for the shot. */
  created: boolean;
  /** Mirrored back over the line. */
  mirrored: boolean;
  /** Refitted to the shot's planned layout. */
  refit: boolean;
  /** The camera agrees with the plan (true without one). */
  agrees: boolean;
  /**
   * What the solve gave up for the shot: its planned layout ('plan': the camera disagrees with it at
   * the shot's first frame, plan_mismatch) or keeping its subjects in frame ('in_frame': out_of_frame
   * names who leaves it, subject_out_of_frame); [] when it kept both.
   */
  gave_up: ('plan' | 'in_frame')[];
  /** Subjects an actor the shot does not frame hides from its camera (occluded_subject); [] when none. */
  occluded: Occlusion[];
  keyframes: number;
}

/** Angles a shot that names none may be solved at instead of its default, to keep its subjects in frame. */
const FREE_ANGLES: readonly DeskAngle[] = [
  'front',
  'three_quarter_left',
  'three_quarter_right',
  'profile_left',
  'profile_right',
];

/** The account of a fit alone (moves.ts FitReport), without its camera. */
const fitOf = (f: FitReport): FitReport => ({
  widened: f.widened,
  distance_ratio: f.distance_ratio,
  effective_framing: f.effective_framing,
  out_of_frame: f.out_of_frame,
  needed_ratio: f.needed_ratio,
});

/** How much less a camera at another angle must stand back to be taken for that alone (share of the distance). */
const FREE_ANGLE_GAIN = 0.1;

/**
 * A shot's camera fitted over the shot (moves.ts fitShotCamera); a shot that names no angle and whose
 * camera at its default angle lets a subject leave the frame, or stands back far enough to read as a
 * wider framing (a subject moving along the view axis, past the camera or out of its framing), tries
 * the others of FREE_ANGLES before keeping that: one that loses fewer of its subjects at the frames
 * desk.check samples (moves.ts shotFitLosses: out of frame, or walking so far away along the view that
 * they no longer read at the framing), else one that keeps the shot's framing where the default does
 * not, else one that stands back clearly less (FREE_ANGLE_GAIN): the side angle that sees it cross
 * the frame. The default angle is kept on a tie. Groups do not try profiles (one of the pair would
 * hide the other, on the line of action).
 */
function fitFreeAngle(
  scene: DeskScene,
  shot: ShotData,
  spec: SolveSpec,
  o: Parameters<typeof fitShotCamera>[3],
): { spec: SolveSpec; solved: ReturnType<typeof fitShotCamera> } {
  const solved = fitShotCamera(scene, spec, shot, o);
  const reads = (c: ReturnType<typeof fitShotCamera>) => c.effective_framing === spec.framing;
  if (
    shot.angle !== null ||
    !FREE_ANGLES.includes(spec.angle) ||
    (!solved.out_of_frame.length && reads(solved))
  )
    return { spec, solved };
  const lost = (s: SolveSpec, c: ReturnType<typeof fitShotCamera>) =>
    shotFitLosses(scene, s, shot, { position: c.position, target: c.target, lens: c.lens_mm }, o);
  type Fit = { spec: SolveSpec; solved: ReturnType<typeof fitShotCamera>; lost: number };
  // fewer subjects lost, then the shot's framing kept, then clearly less standing back
  const better = (a: Fit, b: Fit): boolean =>
    a.lost !== b.lost
      ? a.lost < b.lost
      : reads(a.solved) !== reads(b.solved)
        ? reads(a.solved)
        : a.solved.distance_ratio < b.solved.distance_ratio * (1 - FREE_ANGLE_GAIN);
  let best: Fit = { spec, solved, lost: lost(spec, solved) };
  const group = shot.subjects.length > 1;
  for (const angle of FREE_ANGLES) {
    if (angle === spec.angle || (group && angle.startsWith('profile'))) continue;
    const s = { ...spec, angle };
    const c = fitShotCamera(scene, s, shot, o);
    const fit = { spec: s, solved: c, lost: lost(s, c) };
    if (better(fit, best)) best = fit;
  }
  return { spec: best.spec, solved: best.solved };
}

/** 'an' before a framing that starts with a vowel ('an extreme wide'), else 'a'. */
const article = (framing: string): string => (/^[aeiou]/.test(framing) ? 'an' : 'a');

/** The warning a shot's solve reports (null when it kept its framing, its plan and its subjects). */
function fitWarning(shot: ShotData, spec: SolveSpec, r: SolvedShot, planAgreeing: boolean): string | null {
  const parts: string[] = [];
  const framing = spec.framing.replace(/_/g, ' ');
  if (r.out_of_frame.length) {
    const who = r.out_of_frame.map(
      (o) => `${o.name} (frame${o.frames.length > 1 ? 's' : ''} ${o.frames.join(', ')})`,
    );
    parts.push(
      `${who.join(', ')} ${r.out_of_frame.length > 1 ? 'leave' : 'leaves'} its frame` +
        (r.needed_ratio
          ? `: keeping ${r.out_of_frame.length > 1 ? 'them' : 'it'} would take a camera ${r.needed_ratio.toFixed(1)} times as far back as ${article(spec.framing)} ${framing}'s, and the solve widens ${article(spec.framing)} ${framing} at most ${MAX_WIDEN[spec.framing]} times`
          : '') +
        ` (restage, choose a wider framing, or follow or pan with ${r.out_of_frame.length > 1 ? 'them' : 'it'}: tracking_follow, steadicam_walk, pan_left/right)`,
    );
  }
  if (r.effective_framing !== spec.framing)
    parts.push(
      `its camera stands ${r.distance_ratio.toFixed(1)} times as far back as ${article(spec.framing)} ${framing}'s, so it reads as ${article(r.effective_framing)} ${r.effective_framing.replace(/_/g, ' ')} (set framing '${r.effective_framing}' to say so, or restage)`,
    );
  if (r.gave_up.includes('plan'))
    parts.push(
      `its camera disagrees with its planned layout (plan_mismatch): ${
        planAgreeing
          ? 'a camera that agrees with it lets a subject leave the frame, and keeping the subjects in frame comes first'
          : 'no camera around its subjects agrees with it (restage, or change the plan)'
      }`,
    );
  else if (shot.layout.length && r.gave_up.includes('in_frame'))
    parts.push('the camera keeps its planned layout, so not all of its subjects stay in frame');
  const at = (frames: number[]) => `frame${frames.length > 1 ? 's' : ''} ${frames.join(', ')}`;
  for (const o of r.occluded) {
    const by = o.by.join(' and ');
    // its eyes hidden (it does not read), else its body below them
    const what = o.frames.length
      ? `${o.name} (${at(o.frames)}${o.body_frames.length ? `; the body only at ${at(o.body_frames)}` : ''})`
      : `the body of ${o.name} (${at(o.body_frames)})`;
    parts.push(
      `${what} is hidden behind ${by}, who ${o.by.length > 1 ? 'are' : 'is'} not in the shot (occluded_subject: ` +
        `restage, add ${by} to its subjects, or choose another angle or height)`,
    );
  }
  return parts.length
    ? `Shot '${shot.name}' (${framing}${shot.move ? `, ${shot.move}` : ''}): ${parts.join('; ')}`
    : null;
}

/**
 * Solves the cameras of the shots `ids` (rideo's flow): each in cut order from its framing, angle,
 * height, subjects and lens, on the side of the line set by the cameras placed before it (cameras for
 * shots without one are added), fitted over the shot to keep its subjects in frame within a framing
 * step and to see past actors outside the shot (moves.ts fitShotCamera; a shot that names no angle may
 * take another that needs less); then,
 * with `enforce_line`, cameras of cuts that crossed the line are mirrored back; then, with
 * `fit_plan`, each shot with a planned layout is fitted to it (the plan wins over the line; a camera
 * that agrees with the plan and keeps the subjects in frame first, plan.ts planFit); last each shot's
 * move is keyed from its final pose. Writes the shots and cameras, and reports a warning for each
 * shot whose camera widens its framing, loses a subject, gives up its plan or has a subject hidden
 * behind an actor outside the shot (the result says which).
 */
export function solveShotCameras(
  ctx: OperatorContext,
  ids: readonly string[],
  o: { enforce_line: boolean; fit_plan: boolean; keep_lens: boolean },
): SolvedShot[] {
  const doc = ctx.doc;
  let shots = getShots(doc);
  const targets = new Set(ids);
  const created = new Set<string>();
  // a camera for every target shot that has none
  for (const s of shots) {
    if (!targets.has(s.id) || s.camera) continue;
    const framing = s.framing ?? DEFAULT_FRAMING;
    s.camera = addDeskCamera(doc, {
      name: s.name,
      shotId: s.id,
      lens: s.lens_mm ?? FRAMING_TABLE[framing].lens_mm,
      at: ctx.state.cursorLocation,
    });
    created.add(s.id);
    if (!doc.getScene().camera) doc.updateScene({ camera: s.camera });
  }
  if (created.size) shots = setShots(doc, shots);
  const use = cameraUse(shots);
  const order = shots.filter((s) => targets.has(s.id) && s.camera);
  const index = (id: string) => shots.findIndex((s) => s.id === id);
  const poses = new Map<string, CameraPose>();
  const specs = new Map<string, SolveSpec>();
  const info = new Map<string, SolvedShot>();
  const pending = new Set(order.map((s) => s.id));
  const cursor = ctx.state.cursorLocation;
  const fallbackTarget: Vec3 = [cursor[0], cursor[1], cursor[2] + 1];
  // the solve keys cameras only: when nothing else depends on a camera, the subjects (and the set)
  // are measured once and each new reading takes just the cameras afresh
  const first = new DeskScene(doc);
  const measured = first.camerasLeadNothing() ? first : null;
  const reading = () => (measured ? new DeskScene(doc, { subjects: measured }) : new DeskScene(doc));
  for (const s of order) {
    const scene = reading();
    // rideo's normalizeBlocking: the line of the shots placed so far and this one (whose camera does
    // not count yet), so the first shot already keeps to the side facing the front of the set
    const placed = shots
      .filter((x) => (x.enabled && x.camera && !pending.has(x.id)) || x.id === s.id)
      .map((x) => (x.id === s.id ? { ...x, camera: null } : x));
    const line = lineOfAction(scene, placed);
    const lens = o.keep_lens && s.lens_mm === null ? scene.camera(s.camera!, s.frame_start)?.lens : null;
    // fitted to where its subjects go over the shot and kept in frame through its move (F3)
    const { spec, solved } = fitFreeAngle(scene, s, shotSpec(scene, s, index(s.id), lens), {
      line: linePointsAt(scene, line, s.frame_start),
      fallbackTarget,
    });
    const pose = { position: solved.position, target: solved.target, lens: solved.lens_mm };
    poses.set(s.id, pose);
    specs.set(s.id, spec);
    poseShot(ctx, s, pose, (use.get(s.camera!) ?? 0) > 1, null, scene);
    pending.delete(s.id);
    info.set(s.id, {
      id: s.id,
      name: s.name,
      camera: s.camera!,
      angle: spec.angle,
      created: created.has(s.id),
      mirrored: false,
      refit: false,
      agrees: true,
      ...fitOf(solved),
      gave_up: [],
      occluded: [],
      keyframes: 0,
    });
  }
  // the 180° line: cuts on the wrong side mirrored back (orbits cross it by design)
  if (o.enforce_line) {
    const scene = reading();
    const line = lineOfAction(
      scene,
      shots.filter((x) => x.enabled),
    );
    if (line)
      for (const s of order) {
        if (!crossesLine(scene, line, s)) continue;
        const pts = pairPoints(scene, [line.a, line.b], s.frame_start)!;
        // its subjects kept in frame from the mirrored side too (staying on it)
        const pose = keepShotInFrame(scene, specs.get(s.id)!, s, mirrorPose(pts.a, pts.b, poses.get(s.id)!), {
          ...pts,
          side: line.side,
        });
        poses.set(s.id, pose);
        poseShot(ctx, s, pose, (use.get(s.camera!) ?? 0) > 1, null, scene);
        info.get(s.id)!.mirrored = true;
      }
  }
  // the plan wins over the line
  const agreeing = new Map<string, boolean>();
  if (o.fit_plan) {
    let changed = false;
    for (const s of order) {
      if (!s.layout.length) continue;
      const scene = reading();
      const fit = planFit(scene, s, index(s.id), {
        lens: o.keep_lens && s.lens_mm === null ? poses.get(s.id)?.lens : null,
        pose: poses.get(s.id),
      });
      if (!fit) continue;
      const entry = info.get(s.id)!;
      entry.agrees = fit.agreement.agrees;
      agreeing.set(s.id, fit.agreeing);
      if (!fit.spec || !fit.solved) continue;
      const pose = { position: fit.solved.position, target: fit.solved.target, lens: fit.solved.lens_mm };
      poses.set(s.id, pose);
      specs.set(s.id, fit.spec);
      poseShot(ctx, s, pose, (use.get(s.camera!) ?? 0) > 1, null, scene);
      entry.refit = true;
      entry.angle = fit.spec.angle;
      const i = index(s.id);
      shots[i] = { ...shots[i], angle: fit.spec.angle, subjects: fit.spec.subjects };
      changed = true;
    }
    if (changed) shots = setShots(doc, shots);
  }
  // the moves, from each shot's final pose; what each camera came to, from that pose
  const scene = reading();
  const line = lineOfAction(
    scene,
    shots.filter((x) => x.enabled),
  );
  for (const s of order) {
    const current = shots[index(s.id)];
    const pose = poses.get(s.id)!;
    const r = poseShot(ctx, current, pose, (use.get(s.camera!) ?? 0) > 1, current.move, scene);
    const entry = info.get(s.id)!;
    entry.keyframes = r.keyframes;
    const spec = { ...specs.get(s.id)!, subjects: [...current.subjects] };
    Object.assign(
      entry,
      shotFitReport(scene, spec, current, pose, {
        line: linePointsAt(scene, line, current.frame_start),
        fallbackTarget,
      }),
    );
    entry.gave_up = [
      ...(current.layout.length && !entry.agrees ? (['plan'] as const) : []),
      ...(entry.out_of_frame.length ? (['in_frame'] as const) : []),
    ];
    entry.occluded = shotOcclusions(scene, spec, current, pose);
    const warning = fitWarning(current, spec, entry, agreeing.get(s.id) ?? false);
    if (warning) ctx.report('WARNING', warning);
  }
  return order.map((s) => info.get(s.id)!);
}

/** Whether a shot's camera can be evaluated at its first frame (a move can be keyed from where it stands). */
function cameraStands(doc: OperatorContext['doc'], shot: ShotData): boolean {
  return !!shot.camera && !!new DeskScene(doc).camera(shot.camera, shot.frame_start);
}

function shotSummary(ctx: OperatorContext, s: ShotData) {
  return {
    id: s.id,
    name: s.name,
    camera: s.camera,
    camera_name: s.camera ? (ctx.doc.getObject(s.camera)?.name ?? null) : null,
    frame_start: s.frame_start,
    frame_end: s.frame_end,
  };
}

/** The issues of a check that concern `ids` (and the scene's own). */
function issuesOf(ctx: OperatorContext, ids: readonly string[]): DeskIssue[] {
  if (!ids.length) return [];
  return checkShots(ctx.doc, { shots: ids }).issues;
}

// ---------------------------------------------------------------- operators

interface ShotFields {
  framing?: DeskFraming | null;
  angle?: DeskAngle | null;
  height?: DeskHeight | null;
  move?: DeskMove | null;
  lens_mm?: number | null;
}

interface ShotAddParams extends ShotFields {
  name?: string;
  camera?: string;
  frame_start?: number;
  frame_end?: number;
  duration_s?: number;
  subjects?: string[];
  layout?: LayoutParam[];
  notes?: string;
  continuity: 'cut' | 'continuous';
  pre_roll: number;
  solve: boolean;
  from_view?: { position: Vec3; target: Vec3; lens_mm: number };
  index?: number;
}

function shotAdd(ctx: OperatorContext, p: ShotAddParams) {
  const doc = ctx.doc;
  const shots = getShots(doc);
  if (shots.length >= MAX_SHOTS)
    throw new OperatorError(`A scene holds at most ${MAX_SHOTS} shots`, 'FAILED');
  const cast = castOf(ctx, p.subjects, p.layout, { subjects: [], layout: [] });
  const scene = doc.getScene();
  const lastEnd = shots.length ? Math.max(...shots.map((s) => s.frame_end)) : null;
  const start = p.frame_start ?? (lastEnd === null ? scene.frame_start : lastEnd + 1) + p.pre_roll;
  const end =
    p.frame_end ?? start + Math.max(1, Math.round((p.duration_s ?? DEFAULT_SHOT_SECONDS) * fpsOf(ctx))) - 1;
  if (end < start)
    throw new OperatorError(`frame_end (${end}) must be at least frame_start (${start})`, 'INVALID_PARAMS');
  if (Math.abs(start) > MAX_SHOT_FRAME || Math.abs(end) > MAX_SHOT_FRAME)
    throw new OperatorError(`Shot frames must be within ±${MAX_SHOT_FRAME}`, 'INVALID_PARAMS');
  const id = newShotId();
  const name = p.name ?? freeShotName(shots);
  const framing = p.framing ?? null;
  let camera: string;
  let added = false;
  if (p.camera !== undefined) {
    camera = cameraRef(ctx, p.camera);
    refuseCameraOverlap(shots, { id, name }, camera, start, end, doc.getObject(camera)?.name ?? camera);
  } else {
    const lens = p.lens_mm ?? p.from_view?.lens_mm ?? FRAMING_TABLE[framing ?? DEFAULT_FRAMING].lens_mm;
    camera = addDeskCamera(doc, { name, shotId: id, lens, at: ctx.state.cursorLocation });
    added = true;
    if (!scene.camera) doc.updateScene({ camera });
  }
  const shot: ShotData = {
    id,
    name,
    enabled: true,
    camera,
    frame_start: start,
    frame_end: end,
    notes: p.notes ?? '',
    framing,
    angle: p.angle ?? null,
    height: p.height ?? null,
    move: p.move ?? null,
    lens_mm: p.lens_mm ?? null,
    subjects: cast.subjects,
    layout: cast.layout,
    continuity: p.continuity,
    pre_roll: p.pre_roll,
    external: null,
  };
  const at = Math.min(p.index ?? shots.length, shots.length);
  shots.splice(at, 0, shot);
  const stored = setShots(doc, shots);
  extendScene(ctx, end);
  const saved = stored.find((s) => s.id === id)!;
  let solve: SolvedShot | null = null;
  if (p.from_view) {
    poseShot(
      ctx,
      saved,
      { position: [...p.from_view.position], target: [...p.from_view.target], lens: p.from_view.lens_mm },
      (cameraUse(stored).get(camera) ?? 0) > 1,
      saved.move,
    );
  } else if (p.solve && (saved.subjects.length || saved.framing)) {
    solve = solveShotCameras(ctx, [id], { enforce_line: false, fit_plan: true, keep_lens: false })[0] ?? null;
  } else if (saved.move && cameraStands(doc, saved)) {
    poseShot(ctx, saved, null, (cameraUse(stored).get(camera) ?? 0) > 1, saved.move);
  }
  if (added) setSelection(ctx, [camera], camera);
  const final = getShots(doc).find((s) => s.id === id)!;
  return { shot: shotSummary(ctx, final), solved: !!solve, solve };
}

interface ShotUpdateParams extends ShotFields {
  shot: string;
  name?: string;
  enabled?: boolean;
  camera?: string | null;
  frame_start?: number;
  frame_end?: number;
  duration_s?: number;
  subjects?: string[];
  layout?: LayoutParam[];
  notes?: string;
  continuity?: 'cut' | 'continuous';
  pre_roll?: number;
  resolve?: boolean;
}

function shotUpdate(ctx: OperatorContext, p: ShotUpdateParams) {
  const doc = ctx.doc;
  const shots = getShots(doc);
  const i = shotRefIndex(shots, p.shot);
  const old = shots[i];
  const s: ShotData = { ...old };
  if (p.name !== undefined) s.name = p.name;
  if (p.enabled !== undefined) s.enabled = p.enabled;
  if (p.camera !== undefined) s.camera = p.camera === null ? null : cameraRef(ctx, p.camera);
  if (p.notes !== undefined) s.notes = p.notes;
  if (p.continuity !== undefined) s.continuity = p.continuity;
  if (p.pre_roll !== undefined) s.pre_roll = p.pre_roll;
  if (p.framing !== undefined) s.framing = p.framing;
  if (p.angle !== undefined) s.angle = p.angle;
  if (p.height !== undefined) s.height = p.height;
  if (p.move !== undefined) s.move = p.move;
  if (p.lens_mm !== undefined) s.lens_mm = p.lens_mm;
  const cast = castOf(ctx, p.subjects, p.layout, { subjects: old.subjects, layout: old.layout });
  s.subjects = cast.subjects;
  s.layout = cast.layout;
  // the range: a new start keeps the length unless an end or a duration is given
  const start = p.frame_start ?? old.frame_start;
  let end = old.frame_end + (start - old.frame_start);
  if (p.duration_s !== undefined) end = start + Math.max(1, Math.round(p.duration_s * fpsOf(ctx))) - 1;
  if (p.frame_end !== undefined) end = p.frame_end;
  if (end < start)
    throw new OperatorError(`frame_end (${end}) must be at least frame_start (${start})`, 'INVALID_PARAMS');
  // a new range or camera may not overlap another shot on that camera (its keys would be replaced)
  if (start !== old.frame_start || end !== old.frame_end || s.camera !== old.camera)
    refuseCameraOverlap(
      shots,
      s,
      s.camera,
      start,
      end,
      s.camera ? (doc.getObject(s.camera)?.name ?? s.camera) : '',
    );
  s.frame_start = start;
  s.frame_end = end;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const specChanged = (['framing', 'angle', 'height', 'move', 'lens_mm', 'subjects', 'layout'] as const).some(
    (k) => p[k] !== undefined && !same(s[k], old[k]),
  );
  const resolve = p.resolve ?? specChanged;
  shots[i] = s;
  const stored = setShots(doc, shots);
  extendScene(ctx, end);
  const saved = stored[i];
  const rangeChanged = saved.frame_start !== old.frame_start || saved.frame_end !== old.frame_end;
  let solve: SolvedShot | null = null;
  // the shot's keys follow it to its new range (a solve then replaces them there); the other shots
  // on the camera keep their views
  if (saved.camera && saved.camera === old.camera && rangeChanged)
    retimeCameraRange(
      doc,
      saved.camera,
      [old.frame_start, old.frame_end],
      [saved.frame_start, saved.frame_end],
      cameraHolds(stored, saved.camera, saved.frame_start, saved.frame_end, saved.id),
    );
  if (resolve) {
    solve =
      solveShotCameras(ctx, [saved.id], { enforce_line: true, fit_plan: true, keep_lens: false })[0] ?? null;
  } else if (saved.camera) {
    if (p.move !== undefined && saved.move !== old.move && cameraStands(doc, saved))
      poseShot(ctx, saved, null, (cameraUse(stored).get(saved.camera) ?? 0) > 1, saved.move);
  }
  const final = getShots(doc).find((x) => x.id === saved.id)!;
  return { shot: { ...shotSummary(ctx, final), enabled: final.enabled }, solved: !!solve, solve };
}

function shotRemove(ctx: OperatorContext, p: { shots: string[]; delete_cameras: boolean }) {
  const doc = ctx.doc;
  const shots = getShots(doc);
  const remove = new Set(p.shots.map((ref) => shots[shotRefIndex(shots, ref)].id));
  const removed = shots.filter((s) => remove.has(s.id));
  const kept = shots.filter((s) => !remove.has(s.id));
  setShots(doc, kept);
  const deleted: string[] = [];
  if (p.delete_cameras) {
    const still = new Set(kept.map((s) => s.camera).filter((c): c is string => !!c));
    for (const s of removed)
      if (s.camera && !still.has(s.camera) && !deleted.includes(s.camera)) deleted.push(s.camera);
    doc.removeObjects(deleted);
    const gone = new Set(deleted);
    setSelection(
      ctx,
      ctx.state.selectedIds.filter((id) => !gone.has(id)),
      gone.has(ctx.state.activeId ?? '') ? null : ctx.state.activeId,
    );
  }
  return { removed: removed.map((s) => ({ id: s.id, name: s.name })), deleted_cameras: deleted };
}

function shotMove(ctx: OperatorContext, p: { shot: string; index: number }) {
  const shots = getShots(ctx.doc);
  const i = shotRefIndex(shots, p.shot);
  const [shot] = shots.splice(i, 1);
  shots.splice(Math.min(p.index, shots.length), 0, shot);
  const stored = setShots(ctx.doc, shots);
  return { order: stored.map((s) => ({ id: s.id, name: s.name })) };
}

function shotSolve(
  ctx: OperatorContext,
  p: {
    shots?: string[];
    enforce_line: boolean;
    fit_plan: boolean;
    keep_lens: boolean;
    only_missing: boolean;
  },
) {
  const shots = getShots(ctx.doc);
  let targets = p.shots?.length
    ? p.shots.map((ref) => shots[shotRefIndex(shots, ref)])
    : shots.filter((s) => s.enabled);
  if (p.only_missing) targets = targets.filter((s) => !s.camera);
  const ids = [...new Set(targets.map((s) => s.id))];
  // solveShotCameras warns of each shot that reads as another framing, loses a subject or its plan, or has
  // a subject hidden behind an actor outside the shot
  const solved = solveShotCameras(ctx, ids, p);
  return { shots: solved, issues: issuesOf(ctx, ids) };
}

function cameraMove(
  ctx: OperatorContext,
  p: {
    camera?: string;
    shot?: string;
    move: DeskMove;
    frame_start?: number;
    frame_end?: number;
    amount?: number;
  },
) {
  const doc = ctx.doc;
  const shots = getShots(doc);
  const i = p.shot !== undefined ? shotRefIndex(shots, p.shot) : -1;
  const shot = i >= 0 ? shots[i] : null;
  const camera = p.camera !== undefined ? cameraRef(ctx, p.camera) : shot?.camera;
  if (!camera)
    throw new OperatorError(
      shot
        ? `Shot '${shot.name}' has no camera: give camera, or solve the shot first`
        : 'Give camera or shot',
      'INVALID_PARAMS',
    );
  const scene = doc.getScene();
  const start = p.frame_start ?? shot?.frame_start ?? scene.frame_start;
  const end = p.frame_end ?? shot?.frame_end ?? scene.frame_end;
  if (end < start)
    throw new OperatorError(`frame_end (${end}) must be at least frame_start (${start})`, 'INVALID_PARAMS');
  const desk = new DeskScene(doc);
  if (!desk.camera(camera, start))
    throw new OperatorError(`Camera '${doc.getObject(camera)?.name}' cannot be evaluated`, 'FAILED');
  const subjects = shot?.subjects ?? [];
  const use = cameraUse(shots);
  // from where the camera stands (its roll kept), looking at the shot's subjects; the other shots on
  // the camera keep their views
  const r = applyCameraMove(doc, camera, p.move, {
    frame_start: start,
    frame_end: end,
    amount: p.amount,
    seed: shot?.id ?? camera,
    subjects,
    scene: desk,
    keyed: (use.get(camera) ?? 0) > 1,
    holds: cameraHolds(shots, camera, start, end, shot?.id),
  });
  // the shot's move follows what its camera does over its range
  if (
    shot &&
    shot.camera === camera &&
    start === shot.frame_start &&
    end === shot.frame_end &&
    shot.move !== p.move
  ) {
    shots[i] = { ...shot, move: p.move };
    setShots(doc, shots);
  }
  return {
    camera,
    camera_name: doc.getObject(camera)?.name ?? null,
    move: p.move,
    frame_start: start,
    frame_end: end,
    keyframes: r.keyframes,
    end: r.end && { position: r.end.position, target: r.end.target, lens_mm: r.end.lens },
  };
}

function setBuild(
  ctx: OperatorContext,
  p: {
    width: number;
    depth: number;
    ground: string;
    interior: boolean;
    sun_azimuth_deg: number;
    sun_elevation_deg: number;
    sky: boolean;
  },
) {
  const r = buildSet(ctx.doc, p);
  // exactly one key light: say which other lights light the set too
  const others = ctx.doc
    .listObjects()
    .filter(
      (o) => o.type === 'LIGHT' && !o.hide_render && o.id !== r.sun && deskProp(o, DESK_PROPS.role) !== 'set',
    );
  if (others.length)
    ctx.report(
      'WARNING',
      `${others.length === 1 ? 'A light' : `${others.length} lights`} besides the set's ${p.sky ? 'sky sun' : 'sun lamp'} light${
        others.length === 1 ? 's' : ''
      } the set: ${others
        .slice(0, 5)
        .map((o) => o.name)
        .join(', ')} (hide them in renders for one key light)`,
    );
  const name = (id: string | null) => (id ? (ctx.doc.getObject(id)?.name ?? null) : null);
  return {
    ground: r.ground,
    ground_name: name(r.ground),
    walls: r.walls,
    sun: r.sun,
    sun_name: name(r.sun),
    removed: r.removed,
  };
}

export function registerDeskShotOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'desk.shot_add',
      label: 'Add Shot',
      description:
        'Add a shot to the cut: a camera over a range of scene frames with what it should show. Without `camera` a ' +
        'new camera named after the shot is added; with `solve` and subjects or a framing the camera is solved ' +
        "(rideo's framing table: coverage, lens and look-at height per framing; angle and height around the " +
        'subjects; fitted to `layout` when given; the move keyed over the shot). The range defaults to ' +
        "duration_s (5 s) after the last shot's end and extends the scene's frame_end. Returns {shot: {id, name, " +
        'camera, camera_name, frame_start, frame_end}, solved, solve}: solve (null when not solved) is what the ' +
        'solve came to, as desk.shot_solve reports it (angle; widened, distance_ratio and effective_framing when ' +
        'the camera stands back to keep its subjects in frame; out_of_frame: subjects that still leave it; ' +
        'gave_up; occluded), and a warning says what it gave up.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        name: z
          .string()
          .min(1)
          .max(MAX_SHOT_NAME)
          .optional()
          .describe(
            `Shot name, at most ${MAX_SHOT_NAME} characters (default "Shot N"); also names a new camera`,
          ),
        camera: z
          .string()
          .optional()
          .describe(
            'CAMERA object id or exact name to shoot with (default: a new camera named after the shot)',
          ),
        frame_start: frameStartSchema
          .optional()
          .describe(
            "First scene frame (default: the frame after the last shot's end, or the scene's frame_start)",
          ),
        frame_end: frameEndSchema
          .optional()
          .describe('Last scene frame, inclusive (default: from duration_s)'),
        duration_s: durationSchema
          .optional()
          .describe('Length in seconds when frame_end is not given (default 5)'),
        framing: framingEnum.optional(),
        angle: angleEnum.optional(),
        height: heightEnum.optional(),
        move: moveEnum.optional(),
        lens_mm: lensSchema.optional(),
        subjects: subjectsSchema.optional(),
        layout: layoutSchema.optional(),
        notes: notesSchema.optional(),
        continuity: continuitySchema.default('cut'),
        pre_roll: preRollSchema.default(0),
        solve: z
          .boolean()
          .default(true)
          .describe('Solve the camera from framing, angle, height, subjects and lens (when they allow it)'),
        from_view: z
          .object({
            position: vec3.describe('Camera position in metres'),
            target: vec3.describe('Point the camera looks at, in metres'),
            lens_mm: lensSchema.describe('Lens focal length in mm'),
          })
          .optional()
          .describe("Place the camera at this view (such as the viewport's) instead of solving it"),
        index: z
          .number()
          .int()
          .min(0)
          .max(MAX_SHOTS)
          .optional()
          .describe('Position in the cut, 0 = first (default: last)'),
      }),
      execute: (ctx, p) => shotAdd(ctx, p),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.shot_update',
      label: 'Update Shot',
      description:
        'Change a shot: only the fields passed change (null clears framing, angle, height, move, lens_mm or the ' +
        'camera). The camera is solved again when `resolve` is true (default: when framing, angle, height, move, ' +
        'lens_mm, subjects or layout change). Returns {shot, solved, solve} (solve as in desk.shot_add).',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        shot: shotRef,
        name: z.string().min(1).max(MAX_SHOT_NAME).optional().describe('New name'),
        enabled: z
          .boolean()
          .optional()
          .describe('Disabled shots stay in the list but are left out of the cut'),
        camera: z.string().nullable().optional().describe('CAMERA object id or exact name, or null for none'),
        frame_start: frameStartSchema.optional(),
        frame_end: frameEndSchema.optional(),
        duration_s: durationSchema.optional(),
        framing: framingEnum.nullable().optional(),
        angle: angleEnum.nullable().optional(),
        height: heightEnum.nullable().optional(),
        move: moveEnum.nullable().optional(),
        lens_mm: lensSchema.nullable().optional(),
        subjects: subjectsSchema.optional(),
        layout: layoutSchema.optional(),
        notes: notesSchema.optional(),
        continuity: continuitySchema.optional(),
        pre_roll: preRollSchema.optional(),
        resolve: z
          .boolean()
          .optional()
          .describe(
            "true: solve the camera again from the shot's new spec; false: keep it where it is (default: solve " +
              'again when framing, angle, height, move, lens_mm, subjects or layout change)',
          ),
      }),
      execute: (ctx, p) => shotUpdate(ctx, p),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.shot_remove',
      label: 'Remove Shots',
      description:
        'Remove shots from the cut; with delete_cameras their cameras too (a camera another shot uses stays). ' +
        'Returns the removed shots.',
      category: 'Desk',
      poll: pollObjectMode,
      schema: z.object({
        shots: z.array(shotRef).min(1).describe('Shot ids or exact names'),
        delete_cameras: z.boolean().default(false).describe("Also delete the shots' cameras"),
      }),
      execute: (ctx, p) => shotRemove(ctx, p),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.shot_move',
      label: 'Move Shot',
      description:
        'Move a shot to another place in the cut (the cut order is the list order). Returns the new order.',
      category: 'Desk',
      poll: pollObjectMode,
      schema: z.object({
        shot: shotRef,
        index: z.number().int().min(0).max(MAX_SHOTS).describe('New position, 0 = first'),
      }),
      execute: (ctx, p) => shotMove(ctx, p),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.shot_solve',
      label: 'Solve Shot Cameras',
      description:
        "Solve the cameras of shots from their framing, angle, height, subjects and lens (rideo's solver), fit them " +
        "to each shot's planned layout, key each shot's move, and keep the cameras on one side of the 180° line " +
        '(the plan wins over the line). Each camera is fitted over its shot to keep its subjects in frame, ' +
        'standing back about a framing step at most (twice the distance of its framing; 2.4 times for wide, 4 for ' +
        'extreme_wide; over_shoulder and pov not at all); a shot that names no angle may take a side angle ' +
        'that keeps them at its framing, and a camera an actor outside the shot blocks steps up to 20° aside or ' +
        '1 m up to see past them. Returns the solved shots (each with angle, widened, distance_ratio, ' +
        'effective_framing, out_of_frame, gave_up: plan and/or in_frame, and occluded: subjects hidden behind ' +
        'an actor outside the shot) and the issues found; a warning names each shot whose camera stands back ' +
        'far enough to read as another framing, loses a subject, gives up its plan or has a subject hidden.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        shots: shotRefs.optional(),
        enforce_line: z
          .boolean()
          .default(true)
          .describe('Mirror cameras that crossed the line of action of the main pair (orbits exempt)'),
        fit_plan: z
          .boolean()
          .default(true)
          .describe("Fit each camera to the shot's planned layout when it has one"),
        keep_lens: z
          .boolean()
          .default(false)
          .describe("Keep each camera's current lens instead of the framing's"),
        only_missing: z.boolean().default(false).describe('Solve only shots that have no camera yet'),
      }),
      execute: (ctx, p) => shotSolve(ctx, p),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.check',
      label: 'Check Shots',
      description:
        'Continuity checks of the shots (read-only): line_crossed, subject_out_of_frame, camera_inside, ' +
        "missing_camera, tether_detached (a kite's string left where the flight tied it), walks_on_water (an " +
        'actor standing or walking on a lake, pond or stream in the picture) (errors); plan_mismatch, ' +
        'screen_direction, jump_cut, absent_in_frame, subject_hidden (a subject scaled to nothing by a hide key), ' +
        'subject_revealed (a subject a pan or a tilt brings into the frame by its last frame), occluded_subject (a ' +
        'subject behind an actor the shot does not frame), body_in_water (a physics body in water it does not ' +
        "float on: bake with desk.physics_bake water: 'float'), actors_overlap, outside_set, empty_shot, " +
        'duration_clamped (warnings); physics_unbaked, shot_gap (info). Returns {issues, lines: [{shot, line}] ' +
        "(rideo's blocking sentence), layouts: [{shot, layout}], summary}.",
      category: 'Desk',
      undo: false,
      schema: z.object({ shots: shotRefs.optional() }),
      execute: (ctx, p) => {
        const shots = getShots(ctx.doc);
        for (const ref of p.shots ?? []) shotRefIndex(shots, ref);
        return checkShots(ctx.doc, { shots: p.shots });
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.set_build',
      label: 'Build Set',
      description:
        "Build the set (rideo's set): a ground plane of width × depth coloured from the ground's name, a SKY world " +
        'with the sun at the given azimuth and elevation (one key light; without sky a STUDIO world and one SUN ' +
        'lamp from there), and when interior four 3.2 m walls facing into the room (their backs culled, so a ' +
        'camera outside sees in). Rebuilding replaces the set it built before. Returns {ground, walls, sun (the ' +
        'lamp, without sky), removed}.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        width: z
          .number()
          .min(1)
          .max(10_000)
          .default(12)
          .describe('Set width in metres along X (rideo default 12)'),
        depth: z
          .number()
          .min(1)
          .max(10_000)
          .default(10)
          .describe('Set depth in metres along Y (rideo default 10)'),
        ground: z
          .string()
          .max(80)
          .default('grass')
          .describe(
            "What the ground is (grass, sand, road, wooden floor …): names its colour, as rideo's set.ground",
          ),
        interior: z.boolean().default(false).describe('Add 3.2 m walls around the set'),
        sun_azimuth_deg: z
          .number()
          .min(-3600)
          .max(3600)
          .default(135)
          .describe(
            'Direction toward the sun in degrees about +Z: 0 = in front of the set (−Y), 90 = to its right (+X), ' +
              '180 = behind it (rideo azimuthDeg; default 135)',
          ),
        sun_elevation_deg: z
          .number()
          .min(2)
          .max(90)
          .default(40)
          .describe('Sun height above the horizon in degrees (rideo elevationDeg; default 40)'),
        sky: z
          .boolean()
          .default(true)
          .describe('true: a SKY world whose sun lights the set; false: a STUDIO world and one SUN lamp'),
      }),
      execute: (ctx, p) => setBuild(ctx, p),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.camera_move',
      label: 'Camera Move',
      description:
        "Key a camera move over a shot's range (or frame_start…frame_end): push/pull/dolly/crane eased, orbits along " +
        'their arc, pans and tilts by rotation, whip_pan a fast 90° turn mid-shot, handheld a NOISE modifier, ' +
        'dolly_zoom the lens against the distance, rack_focus the focus distance, tracking_follow and ' +
        'steadicam_walk following the first subject. Give `camera` or `shot`. Returns the keyed range.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        camera: z.string().optional().describe("CAMERA object id or exact name (default: the shot's camera)"),
        shot: shotRef.optional().describe('Shot whose camera and range the move uses'),
        move: moveEnum,
        frame_start: z
          .number()
          .int()
          .optional()
          .describe("First frame of the move (default: the shot's frame_start)"),
        frame_end: z
          .number()
          .int()
          .optional()
          .describe("Last frame of the move (default: the shot's frame_end)"),
        amount: z
          .number()
          .min(0)
          .max(10)
          .optional()
          .describe("Strength of the move: 1 = the move library's distance or angle (default 1)"),
      }),
      execute: (ctx, p) => cameraMove(ctx, p),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.import_rideo_blocking',
      label: 'Import rideo Blocking',
      description:
        "Build the scene from a rideo clip's blocking (spec §11): the frame rate and resolution from the " +
        'project settings; shots in rideo order, each round(duration_s × fps) frames, a pre-roll gap before cuts ' +
        'where marks jump; actors keyed at each shot start from their marks (walks to toX/toZ); cameras imported as ' +
        'they are (only shots without one are solved; the line is never enforced on import) and fitted to the ' +
        'planned layout; props as store models (kites and balloons on tethers), landmarks as primitives. Updates a ' +
        'scene imported from the same clip in place. Returns the actors, shots and the issues found.',
      category: 'Desk',
      poll: pollObjectMode,
      schema: z.object({
        blocking: z
          .record(z.string(), z.unknown())
          .describe(
            "rideo SceneBlocking v1 (the blocking route's draft, else its blocking): set, actors, props, shots " +
              '(validated by the importer)',
          ),
        shots: z
          .array(
            z.object({
              id: z.string().describe('rideo shot id'),
              index: z.number().int().min(0).describe('Order in the clip (rideo index)'),
              duration_s: durationSchema.describe('Length in seconds (rideo durationSec)'),
              name: z
                .string()
                .max(MAX_SHOT_NAME)
                .optional()
                .describe('Shot name (default "Shot <index + 1>")'),
              framing: framingEnum.nullable().optional(),
              angle: angleEnum.nullable().optional(),
              height: heightEnum.nullable().optional(),
              move: moveEnum
                .nullable()
                .optional()
                .describe('rideo camera.move (the 20 move ids are the same)'),
              movement: z
                .string()
                .max(40)
                .nullable()
                .optional()
                .describe(
                  'rideo camera.movement, used when move is absent: static, dolly_in, dolly_out, tracking, ' +
                    'handheld, crane, orbit, pan, tilt or zoom',
                ),
              lens_mm: lensSchema.nullable().optional(),
              character_ids: z
                .array(z.string().describe('rideo character id'))
                .max(MAX_SHOT_SUBJECTS)
                .default([])
                .describe("The shot's cast (rideo characterIds)"),
              element_ids: z
                .array(z.string().describe('rideo element id'))
                .max(64)
                .default([])
                .describe("The shot's props and landmarks (rideo elementIds)"),
              layout: z
                .array(
                  z.object({
                    character_id: z.string().describe('rideo character id'),
                    side: z.enum(DESK_SIDES).describe('Planned third of the frame'),
                    facing: z.enum(DESK_FACINGS).describe('Planned facing on screen'),
                  }),
                )
                .max(MAX_SHOT_LAYOUT)
                .default([])
                .describe('Planned screen layout (rideo shot.layout)'),
              continuity: continuitySchema.default('cut'),
              notes: notesSchema.optional().describe("The shot's description and action (kept as notes)"),
              board_state: z
                .string()
                .max(40)
                .nullable()
                .optional()
                .describe("State of the shot's first-frame board in rideo, to warn when it must be redrawn"),
            }),
          )
          .max(MAX_SHOTS)
          .describe("The clip's shots (rideo clip document)"),
        characters: z
          .array(
            z.object({
              id: z.string().describe('rideo character id'),
              name: z.string().max(200).describe('Name'),
              summary: z.string().max(4000).optional().describe('Summary (used to tell people from animals)'),
              identity: z
                .union([
                  z.string().max(4000),
                  z.record(z.string(), z.string().max(4000).nullish().describe('An identity field')),
                ])
                .optional()
                .describe("Identity: rideo's identity fields (age, gender, build, height …) or one text"),
              height_m: z.number().min(0.1).max(10).optional().describe('Standing height in metres'),
            }),
          )
          .default([])
          .describe('The cast (rideo character documents)'),
        elements: z
          .array(
            z.object({
              id: z.string().describe('rideo element id'),
              name: z.string().max(200).describe('Name'),
              label: z.string().max(80).optional().describe('Short label (chooses the store model)'),
              kind: z
                .enum(['location', 'prop', 'style'])
                .nullish()
                .describe("rideo's element kind: location, prop or style"),
              summary: z.string().max(4000).optional().describe('Summary'),
            }),
          )
          .default([])
          .describe('Props and landmarks (rideo element documents)'),
        settings: z
          .object({
            fps: z.number().int().min(1).max(240).describe('Frame rate'),
            width: z.number().int().min(16).max(16_384).describe('Width in pixels'),
            height: z.number().int().min(16).max(16_384).describe('Height in pixels'),
            aspect_ratio: z
              .string()
              .max(10)
              .nullish()
              .describe("rideo's aspect ratio ('16:9' …; the resolution decides, as in rideo)"),
          })
          .optional()
          .describe("rideo project settings (default: the scene's own)"),
        model_limits: z
          .object({
            min_s: z.number().positive().max(3600).nullish().describe("The video model's shortest take (s)"),
            max_s: z.number().positive().max(3600).nullish().describe("The video model's longest take (s)"),
          })
          .nullish()
          .describe(
            "The video model's duration limits (desk min/max_shot_s; rideo clamps durations to them)",
          ),
        state: z
          .enum(['missing', 'incomplete', 'ready'])
          .nullish()
          .describe(
            "rideo's blocking state: 'missing' places the cast from the shots' planned layouts and solves every camera",
          ),
        cast_overrides: z
          .record(z.string(), z.enum(ACTOR_KINDS))
          .optional()
          .describe(
            'Actor kind by rideo character id (default: humanoid, quadrupeds for mounts and pets by name)',
          ),
        project: z
          .string()
          .max(200)
          .optional()
          .describe('rideo project id (kept on the shots for round trips)'),
        clip: z.string().max(200).optional().describe('rideo clip id (kept on the shots for round trips)'),
        pre_roll_frames: z
          .number()
          .int()
          .min(0)
          .max(MAX_PRE_ROLL)
          .default(12)
          .describe('Frames of the gap before a cut where marks jump (animated, never exported)'),
        update: z
          .boolean()
          .default(true)
          .describe(
            'Update a scene imported from this clip before in place (actors by character id, shots by rideo shot ' +
              'id), keeping what was added since; false: add everything anew',
          ),
      }),
      execute: (ctx, p) => importRideoOperator(ctx, p, solveShotCameras),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.export_rideo_blocking',
      label: 'Export rideo Blocking',
      description:
        "The scene as a rideo SceneBlocking v1 (read-only): opening marks at the first shot's start, " +
        'per-shot marks and walk targets, cameras and their end placement, landmark and prop footprints, riders on ' +
        "their mount's mark. Returns {blocking}.",
      category: 'Desk',
      undo: false,
      schema: z.object({}),
      execute: (ctx) => exportRideoOperator(ctx),
    }),
  );
}
