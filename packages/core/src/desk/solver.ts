import type { Vec3 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import type { DeskAngle, DeskFraming, DeskHeight, DeskMove, ShotData } from '../doc/types';
import { DeskScene, toEditor, toRideo, v3add, v3sub, type DeskSubject, type RVec } from './layout';

/*
 * The camera solver (spec §6): rideo's solveCamera, moveEnd and cameraMoveOf (shared/src/blocking,
 * re-implemented with the same rules and numbers) in editor axes. The formulas run in rideo's
 * coordinates (y up, z towards the audience; layout.ts toRideo / toEditor at the boundary) so that
 * they read like rideo's and give its numbers to the millimetre.
 *
 * Subjects: actors (desk_role 'actor') are rideo's characters, measured at the solved frame (head,
 * eyes, chest, their mark on the floor, facing; layout.ts DeskScene.subject). rideo's figures stand
 * straight over their marks; an actor CHARACTERS measures is framed on its posed body instead: the
 * framing's look share runs from its mark up through its chest, eyes and head (rideo's 0.72, 0.93
 * and 1 of the height), so a close-up finds the face of a seated or lying actor, or of a horse, and
 * a standing person lands where rideo's figure would. An animal is framed by its length as well as
 * its height: aimed at the middle of what the framing shows of it (all of it from a medium out, its
 * head and chest in a close-up), far enough back for that to fill at most 90% of the frame. Other
 * subjects are rideo's props: the target of an insert. A shot with no actor is framed on its other
 * subjects as if they were figures as tall as their bounds (rideo has no measured props and frames a
 * cast-less shot on a 0.3 m stand-in 1.5 m from the eye); a cast-less insert follows rideo exactly;
 * a flying prop sets the camera's height only when no subject stands on the floor.
 *
 * Over a shot (F3): placeCamera takes the subjects at more frames (the shot's samples, mapped by a
 * following move) and aims at the middle of where they go (a moving group across the frame where the
 * camera can come nearest), far enough back for the group at every frame; subjects that stay put
 * give rideo's camera exactly. moves.ts fitShotCamera then keeps every subject in frame through the
 * shot's move, widening the camera when it must.
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

/** Framing a shot without one is solved with. */
export const DEFAULT_FRAMING: DeskFraming = 'medium';

/**
 * How far back a camera may stand to keep its shot's subjects in frame, as a share of the distance of
 * rideo's camera for the shot at its first frame: about one framing step wider, so the frame still
 * reads close to the framing rideo prompts. A close shot twice as far back reads as the next framing
 * out (a close-up as a medium close-up, a medium as a full figure); a wide shot may become an extreme
 * wide (its coverage, 2.4 times a wide's); an extreme wide, the widest framing, up to 4 times.
 * Over-the-shoulder and point-of-view cameras stand where their rules put them. Subjects a camera
 * cannot keep within this leave the frame (desk.check's subject_out_of_frame), and the solve says so.
 */
export const MAX_WIDEN: Readonly<Record<DeskFraming, number>> = {
  extreme_wide: 4,
  wide: 2.4,
  medium: 2,
  medium_close: 2,
  close_up: 2,
  extreme_close_up: 2,
  over_shoulder: 1,
  pov: 1,
  insert: 2,
};

/** The framings by how much of a figure they show, from the closest to the widest. */
const SIZE_FRAMINGS: readonly DeskFraming[] = [
  'extreme_close_up',
  'close_up',
  'medium_close',
  'medium',
  'wide',
  'extreme_wide',
];

/**
 * The framing a camera `ratio` times as far back as rideo's for `framing` amounts to: the framing
 * whose coverage is nearest (by ratio) to the one it covers, the shot's own on a tie.
 */
export function effectiveFraming(framing: DeskFraming, ratio: number): DeskFraming {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return framing;
  const covers = FRAMING_TABLE[framing].coverage_m * ratio;
  let best = framing;
  let off = Math.abs(Math.log(ratio));
  for (const f of SIZE_FRAMINGS) {
    const d = Math.abs(Math.log(covers / FRAMING_TABLE[f].coverage_m));
    if (d < off - 1e-9) {
      best = f;
      off = d;
    }
  }
  return best;
}

/** Room kept beside each subject of a group (m, for a 1.7 m figure) and the margin on the angle it needs. */
const GROUP_PAD_M = 0.25;
const GROUP_MARGIN = 1.1;
/** The share of the frame (from its middle to its edges) what a framing shows of an animal may fill. */
const ANIMAL_ROOM = 0.9;
/** How far a move of rideo's library goes: push/pull share, dolly metres, orbit degrees, crane metres. */
export const PUSH_SHARE = 0.35;
export const DOLLY_M = 1.5;
export const ORBIT_DEG = 30;
export const CRANE_M = 2;

/** A camera placement: where it stands and the point it looks at (editor coordinates). */
export interface CameraPlacement {
  position: Vec3;
  target: Vec3;
}

/** A solved camera: where it stands and looks, its lens, and where its move ends (null: no move). */
export interface SolvedCamera {
  position: Vec3;
  target: Vec3;
  lens_mm: number;
  end: CameraPlacement | null;
}

/** What the solver places a camera from (a shot's description with its defaults filled in). */
export interface SolveSpec {
  framing: DeskFraming;
  angle: DeskAngle;
  height: DeskHeight;
  move: DeskMove | null;
  /** Lens in mm (rounded and clamped to 8–800 by the solver, as rideo's). */
  lens_mm: number;
  /** Subjects in order (the first leads: the shoulder of an over-the-shoulder, the eyes of a POV). */
  subjects: string[];
}

/** The scene's line where a camera is solved: the main pair's floor points and the side cameras keep to. */
export interface LinePoints {
  a: Vec3;
  b: Vec3;
  side: 1 | -1;
}

// ---------------------------------------------------------------- rideo's vector math

const r3 = (x: number, y: number, z: number): RVec => ({ x, y, z });
const UP: RVec = r3(0, 1, 0);
const add = (a: RVec, b: RVec): RVec => r3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: RVec, b: RVec): RVec => r3(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a: RVec, k: number): RVec => r3(a.x * k, a.y * k, a.z * k);
const dot = (a: RVec, b: RVec): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: RVec, b: RVec): RVec =>
  r3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a: RVec): number => Math.hypot(a.x, a.y, a.z);
const norm = (a: RVec): RVec => {
  const l = len(a);
  return l > 1e-9 ? mul(a, 1 / l) : r3(0, 0, 1);
};
const flat = (a: RVec): RVec => r3(a.x, 0, a.z);
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const rad = (deg: number): number => (deg * Math.PI) / 180;

/** A direction turned towards the left of someone facing it (seen from above), as rideo's turnLeft. */
function turnLeft(dir: RVec, deg: number): RVec {
  const left = cross(UP, dir);
  return norm(add(mul(dir, Math.cos(rad(deg))), mul(left, Math.sin(rad(deg)))));
}

/** rideo's lineSide: on which side of the line through a and b a floor point is (+1, −1, or 0 on it). */
export function lineSide(a: Readonly<Vec3>, b: Readonly<Vec3>, p: Readonly<Vec3>): -1 | 0 | 1 {
  const ra = toRideo(a);
  const u = sub(toRideo(b), ra);
  const w = sub(toRideo(p), ra);
  const c = u.x * w.z - u.z * w.x;
  const scale = Math.max(0.05, Math.hypot(u.x, u.z)) * 0.05;
  return Math.abs(c) < scale ? 0 : (Math.sign(c) as -1 | 1);
}

/** A point mirrored across the vertical plane through the floor line a–b (its height kept), as rideo's mirror. */
export function mirrorPoint(a: Readonly<Vec3>, b: Readonly<Vec3>, p: Readonly<Vec3>): Vec3 {
  const ra = toRideo(a);
  const rp = toRideo(p);
  const u = norm(flat(sub(toRideo(b), ra)));
  const w = flat(sub(rp, ra));
  const along = mul(u, dot(w, u));
  const m = sub(mul(along, 2), w);
  return toEditor(r3(ra.x + m.x, rp.y, ra.z + m.z));
}

/** rideo's placement: millimetres, the camera at least 5 cm above the floor, heights within −10…200 m. */
function placement(p: RVec, t: RVec): { pos: RVec; target: RVec } {
  return {
    pos: r3(round3(p.x), round3(clamp(p.y, 0.05, 200)), round3(p.z)),
    target: r3(round3(t.x), round3(clamp(t.y, -10, 200)), round3(t.z)),
  };
}

/** rideo's camera basis (no roll; looking straight down or up the top of the frame is the back of the set). */
function basis(pos: RVec, target: RVec): { forward: RVec; right: RVec; up: RVec } {
  const forward = norm(sub(target, pos));
  const right = Math.abs(forward.y) > 0.999 ? r3(1, 0, 0) : norm(cross(forward, UP));
  return { forward, right, up: cross(right, forward) };
}

// ---------------------------------------------------------------- spec defaults

/**
 * The angle a shot is solved at when it gives none (rideo's defaultCameraSpec): over the shoulder or
 * POV when the framing asks and the cast allows, singles alternating three-quarter left and right
 * by their place in the cut, otherwise the front.
 */
export function defaultAngle(framing: DeskFraming, actorCount: number, index: number): DeskAngle {
  if (framing === 'over_shoulder' && actorCount >= 2) return 'over_shoulder';
  if (framing === 'pov' && actorCount >= 1) return 'pov';
  if (actorCount === 1) return index % 2 === 0 ? 'three_quarter_left' : 'three_quarter_right';
  return 'front';
}

/**
 * The solver's spec of a shot: its own fields, else rideo's defaults (the framing medium, the angle by
 * defaultAngle, eye height). `index`: the shot's place in the cut. `lens`: the lens to keep (the
 * camera's, with keep_lens) when the shot names none.
 */
export function shotSpec(
  scene: DeskScene,
  shot: Pick<ShotData, 'framing' | 'angle' | 'height' | 'move' | 'lens_mm' | 'subjects'>,
  index: number,
  lens?: number | null,
): SolveSpec {
  const framing = shot.framing ?? DEFAULT_FRAMING;
  const actors = shot.subjects.filter((id) => scene.isActor(id)).length;
  return {
    framing,
    angle: shot.angle ?? defaultAngle(framing, actors, index),
    height: shot.height ?? 'eye',
    move: shot.move,
    lens_mm: shot.lens_mm ?? lens ?? FRAMING_TABLE[framing].lens_mm,
    subjects: [...shot.subjects],
  };
}

// ---------------------------------------------------------------- what a shot keeps in frame

/**
 * Moves that turn the camera away from the shot's subjects by design (a pan or tilt to something
 * else, a whip pan): their subjects are checked in frame, and kept in frame by the solve, at the
 * shot's first frame only (rideo checks every shot at its first frame).
 */
export const TURNING_MOVES: ReadonlySet<string> = new Set([
  'pan_left',
  'pan_right',
  'tilt_up',
  'tilt_down',
  'whip_pan',
]);

/** Moves keyed on every frame that follow the shot's subjects (the centre of their group). */
export const FOLLOW_MOVES: ReadonlySet<DeskMove> = new Set(['tracking_follow', 'steadicam_walk']);

/** The first, middle and last frame of a shot (once each): where desk.check samples it. */
export function shotSamples(shot: Pick<ShotData, 'frame_start' | 'frame_end'>): number[] {
  return [
    ...new Set([shot.frame_start, Math.round((shot.frame_start + shot.frame_end) / 2), shot.frame_end]),
  ];
}

/**
 * The frames a shot's subjects must be in frame at (desk.check's subject_out_of_frame, and what the
 * solver keeps them in frame over): its first, middle and last; the first only for turning moves.
 */
export function inFrameSamples(shot: Pick<ShotData, 'frame_start' | 'frame_end' | 'move'>): number[] {
  return shot.move && TURNING_MOVES.has(shot.move) ? [shot.frame_start] : shotSamples(shot);
}

/**
 * The subjects a shot leaves out of its frame by design, by the angle and framing it is solved with
 * (its spec, from shotSpec): the shoulder of an over-the-shoulder shot (its first actor) at the
 * frame's edge, the viewer of a point-of-view shot (its first actor, else its first subject) behind
 * the camera, and the cast of an insert, which frames its prop.
 */
export function unframedSubjects(
  scene: DeskScene,
  subjects: readonly string[],
  spec: Pick<SolveSpec, 'angle' | 'framing'>,
): Set<string> {
  const firstActor = subjects.find((id) => scene.isActor(id));
  const out = new Set<string>();
  if (spec.angle === 'over_shoulder' && firstActor) out.add(firstActor);
  if (spec.angle === 'pov' && (firstActor ?? subjects[0])) out.add(firstActor ?? subjects[0]);
  if (spec.framing === 'insert') {
    const prop = subjects.find((id) => !scene.isActor(id));
    if (prop) for (const id of subjects) if (id !== prop) out.add(id);
  }
  return out;
}

/** Where a camera that follows a group sees a point of a later frame from the first one's place. */
export type FollowMap = (p: Readonly<Vec3>, frame: number) => Vec3;

/**
 * How a following move (tracking_follow, steadicam_walk) carries its camera from the first frame of
 * `span`: the camera moves with the centre of the subjects' group (and a steadicam turns with their
 * heading; scene.groupCentre and groupHeading, as moves.ts applyCameraMove keys it), so a point at a
 * later frame shows where the point it maps to shows at the first. Null for other moves and without
 * subjects. One subject's centre and heading are its own.
 */
export function followMap(
  scene: DeskScene,
  subjects: readonly string[],
  move: DeskMove | null,
  span: { frame_start: number; frame_end: number },
): FollowMap | null {
  if (!move || !FOLLOW_MOVES.has(move)) return null;
  const from = span.frame_start;
  const c0 = scene.groupCentre(subjects, from);
  if (!c0) return null;
  const h0 = scene.groupHeading(subjects, from, span);
  return (p, frame) => {
    const c = scene.groupCentre(subjects, frame) ?? c0;
    if (move === 'tracking_follow') return [p[0] - c[0] + c0[0], p[1] - c[1] + c0[1], p[2] - c[2] + c0[2]];
    const h = scene.groupHeading(subjects, frame, span);
    // the steadicam turned with the heading by `turn`: turn the point back about the centre
    const turn = Math.atan2(h0[0] * h[1] - h0[1] * h[0], h0[0] * h[0] + h0[1] * h[1]);
    const x = p[0] - c[0];
    const y = p[1] - c[1];
    const cs = Math.cos(-turn);
    const sn = Math.sin(-turn);
    return [c0[0] + x * cs - y * sn, c0[1] + x * sn + y * cs, p[2] - c[2] + c0[2]];
  };
}

// ---------------------------------------------------------------- the solver

interface Figure {
  id: string;
  /** Its mark on the floor. */
  feet: RVec;
  eyes: RVec;
  head: RVec;
  height: number;
  facing: RVec;
  /** Its posed body (an actor CHARACTERS measures); null: a figure straight over its mark (rideo's). */
  body: { chest: RVec; eyes: RVec; head: RVec } | null;
  /** The height its framing's coverage scales with: its height; an animal's body length when longer. */
  size: number;
  /** An animal's body: its front and back ends at the height of its middle, that middle and its chest. */
  animal: { front: RVec; back: RVec; middle: RVec; chest: RVec } | null;
  /** A flying prop: the camera takes its height from the subjects on the floor while there are some. */
  airborne: boolean;
}

/** A subject as the solver's figure (rideo coordinates), its points mapped by `map` when given. */
function figureOf(s: DeskSubject, map: ((p: Readonly<Vec3>) => Vec3) | null): Figure {
  const at = (p: Readonly<Vec3>) => toRideo(map ? map(p) : p);
  const facing = map ? v3sub(map(v3add(s.feet, s.facing)), map(s.feet)) : s.facing;
  return {
    id: s.id,
    feet: at(s.feet),
    eyes: at(s.eyes),
    head: at(s.head),
    height: s.height,
    facing: norm(flat(toRideo(facing))),
    body: s.posed ? { chest: at(s.chest), eyes: at(s.eyes), head: at(s.head) } : null,
    size: s.extent ? Math.max(s.height, s.extent.length) : s.height,
    animal: s.extent
      ? { front: at(s.extent.front), back: at(s.extent.back), middle: at(s.center), chest: at(s.chest) }
      : null,
    airborne: s.airborne,
  };
}

/** Shares of a figure's height its mark, chest, eyes and head stand at (rideo's figurePoints). */
const BODY_SHARES = [0, 0.72, 0.93, 1] as const;

/**
 * The point a framing's look share falls on along a posed body: from its mark up through its chest,
 * eyes and head (for a person standing upright, where it falls on rideo's figure); null for a
 * figure without a body.
 */
function bodyPoint(f: Figure, look: number): RVec | null {
  if (!f.body) return null;
  const pts = [f.feet, f.body.chest, f.body.eyes, f.body.head];
  const share = clamp(look, 0, 1);
  let i = 1;
  while (i < pts.length - 1 && share > BODY_SHARES[i]) i++;
  const t = clamp((share - BODY_SHARES[i - 1]) / (BODY_SHARES[i] - BODY_SHARES[i - 1]), 0, 1);
  return add(pts[i - 1], mul(sub(pts[i], pts[i - 1]), t));
}

/**
 * What a framing shows of an animal (F7; rideo frames people only): all of it, head to tail and
 * hooves to ears, from a medium out; its head and chest in a close-up (the front of its body too in a
 * medium close-up); its eyes and nose in an extreme close-up.
 */
function animalShows(f: Figure, a: NonNullable<Figure['animal']>, framing: DeskFraming): RVec[] {
  const level = (p: RVec, y: number) => r3(p.x, y, p.z);
  switch (framing) {
    case 'extreme_close_up':
      return [f.eyes, level(a.front, f.eyes.y)];
    case 'close_up':
      return [f.head, f.eyes, a.chest, level(a.front, f.eyes.y)];
    case 'medium_close':
      return [f.head, a.chest, level(a.front, f.eyes.y), a.middle];
    default:
      return [f.head, a.front, a.back, level(a.front, f.feet.y), level(a.back, f.feet.y)];
  }
}

/** The middle of the box around points. */
function middleOf(pts: readonly RVec[]): RVec {
  const lo = r3(Infinity, Infinity, Infinity);
  const hi = r3(-Infinity, -Infinity, -Infinity);
  for (const p of pts) {
    lo.x = Math.min(lo.x, p.x);
    lo.y = Math.min(lo.y, p.y);
    lo.z = Math.min(lo.z, p.z);
    hi.x = Math.max(hi.x, p.x);
    hi.y = Math.max(hi.y, p.y);
    hi.z = Math.max(hi.z, p.z);
  }
  return r3((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2);
}

/**
 * Where a framing aims on a figure: on a posed person where its look share falls on the body
 * (bodyPoint); on an animal the middle of what the framing shows of it; null for a figure without a
 * body (rideo aims at its mark, at the group's look height).
 */
function aimOf(f: Figure, framing: DeskFraming): RVec | null {
  if (f.animal) return middleOf(animalShows(f, f.animal, framing));
  return bodyPoint(f, FRAMING_TABLE[framing].look);
}

/** What a framing shows of an animal subject (editor coordinates; [] for other subjects). */
export function animalFramePoints(s: DeskSubject, framing: DeskFraming): Vec3[] {
  const f = figureOf(s, null);
  return f.animal ? animalShows(f, f.animal, framing).map(toEditor) : [];
}

/**
 * The point at share `share` of a subject's height (editor coordinates): on a posed body from its
 * mark up through its chest, eyes and head (bodyPoint), else straight over its feet.
 */
export function subjectPoint(s: DeskSubject, share: number): Vec3 {
  const p = bodyPoint(figureOf(s, null), share);
  return p ? toEditor(p) : [s.feet[0], s.feet[1], s.feet[2] + clamp(share, 0, 1) * s.height];
}

/** Options of the solver. */
export interface SolveOptions {
  /** The scene's line: a camera that would stand on its other side is turned back to its side. */
  line?: LinePoints | null;
  /** What a shot without subjects looks at (rideo: 1 m above the origin). */
  fallbackTarget?: Vec3;
  /**
   * More frames the camera frames its subjects over (F3; the shot's samples): it aims at the middle
   * of where they are at all of them and stands back far enough for the group at each. Subjects that
   * do not move give the camera of `frame` alone.
   */
  over?: readonly number[];
  /** How a following move carries the camera from `frame` to the others (followMap). */
  follow?: FollowMap | null;
}

/** A camera placed by the solver, before it backs out of set pieces and is rounded (editor coordinates). */
export interface PlacedCamera {
  position: Vec3;
  target: Vec3;
  /**
   * How it stands: around its subjects by framing, angle and height ('framed'), at a subject's eyes
   * ('pov') or over a subject's shoulder ('shoulder').
   */
  rule: 'framed' | 'pov' | 'shoulder';
}

/**
 * Places a camera from a spec at `frame` (rideo's solveCamera), over `o.over` too when given (F3).
 * With `o.line`, a camera that would stand on the other side of the scene's line is turned back to
 * its side.
 */
export function placeCamera(
  scene: DeskScene,
  spec: SolveSpec,
  frame: number,
  o: SolveOptions = {},
): PlacedCamera {
  const framing = spec.framing;
  const lensMm = clamp(Math.round(spec.lens_mm), 8, 800);
  const tanH = DESK_SENSOR_WIDTH_MM / 2 / Math.max(1, lensMm);
  const tanV = tanH / Math.max(0.1, scene.aspect);
  // the subjects at `frame`, and where a camera fitted to the samples sees them at the others
  const frames = [frame, ...new Set((o.over ?? []).filter((f) => f !== frame))];
  const sets = frames.map((f, i) => {
    const measured = spec.subjects
      .map((id) => scene.subject(id, f))
      .filter((s): s is NonNullable<typeof s> => !!s);
    const map = i > 0 && o.follow ? (p: Readonly<Vec3>) => o.follow!(p, f) : null;
    const actors = measured.filter((s) => s.actor);
    const props = measured.filter((s) => !s.actor);
    const insertProp = framing === 'insert' ? props[0] : undefined;
    // rideo frames characters; a cast-less shot (other than an insert) frames its props as figures
    const from = actors.length || insertProp ? actors : props;
    return {
      figures: from.map((s) => figureOf(s, map)),
      insert: insertProp ? toRideo(map ? map(insertProp.center) : insertProp.center) : null,
    };
  });
  const figures = sets[0].figures;
  const all = sets.flatMap((s) => s.figures);
  const tallest = Math.max(0.3, ...all.map((s) => s.height));
  const scale = clamp(Math.max(0.3, ...all.map((s) => s.size)) / 1.7, 0.3, 3);
  // the camera's height follows the subjects on the floor; flying props set it only on their own
  const grounded = all.some((s) => !s.airborne) ? all.filter((s) => !s.airborne) : all;
  const floor = grounded.length ? Math.min(...grounded.map((s) => s.feet.y)) : 0;
  const line = o.line ? { a: toRideo(o.line.a), b: toRideo(o.line.b), side: o.line.side } : null;
  const sideOf = (a: RVec, b: RVec, p: RVec) => lineSide(toEditor(a), toEditor(b), toEditor(p));
  const onSide = (dir: RVec, from: RVec): RVec => {
    if (!line) return dir;
    const side = sideOf(line.a, line.b, add(from, mul(dir, 3)));
    if (side === line.side) return dir;
    const u = norm(flat(sub(line.b, line.a)));
    if (side === 0) {
      // on the line: turned about 20° towards the scene's side, so the screen sides stay as they were
      let n = turnLeft(u, 90);
      if (sideOf(line.a, line.b, add(line.a, n)) !== line.side) n = mul(n, -1);
      return norm(add(dir, mul(n, 0.36)));
    }
    // reflect the direction across the line
    return norm(sub(mul(u, 2 * dot(dir, u)), dir));
  };
  const placed = (pos: RVec, target: RVec, rule: PlacedCamera['rule']): PlacedCamera => ({
    position: toEditor(pos),
    target: toEditor(target),
    rule,
  });

  // POV: from the first subject's eyes, where they look (at the second subject when there is one)
  if (spec.angle === 'pov' && figures[0]) {
    const s = figures[0];
    const eyes = add(s.eyes, mul(s.facing, 0.12));
    const target = figures[1] ? figures[1].eyes : add(eyes, mul(s.facing, 4));
    return placed(eyes, target, 'pov');
  }
  // over the shoulder: behind the first subject's shoulder on the scene's side, at the second subject
  if (spec.angle === 'over_shoulder' && figures.length >= 2) {
    const [fg, bg] = figures as [Figure, Figure];
    const away = norm(flat(sub(fg.feet, bg.feet)));
    const side = onSide(turnLeft(away, 90), fg.feet);
    const pos = add(add(fg.feet, mul(away, 0.55 * scale)), mul(side, 0.32 * scale));
    return placed(r3(pos.x, fg.feet.y + fg.height * 0.86, pos.z), bg.eyes, 'shoulder');
  }

  // the target: the subjects' centre at the height the framing looks at (the prop of an insert); a
  // posed body is aimed at where the look share falls on it (a lone one in height too: the face of a
  // close-up wherever its pose puts it), an animal at the middle of what the framing shows of it.
  // Over several frames: the middle of where those targets are (exactly the one target when the
  // subjects stay put)
  const look = FRAMING_TABLE[framing].look;
  const targetOf = (set: (typeof sets)[number]): RVec | null => {
    if (set.insert) return set.insert;
    const figs = set.figures;
    if (!figs.length) return null;
    const aims = figs.map((s) => aimOf(s, framing) ?? s.feet);
    const cx = aims.reduce((n, a) => n + a.x, 0) / figs.length;
    const cz = aims.reduce((n, a) => n + a.z, 0) / figs.length;
    const cy = figs.reduce((n, s) => n + s.feet.y, 0) / figs.length;
    const lone = figs.length === 1 ? aimOf(figs[0], framing) : null;
    return r3(cx, lone ? lone.y : cy + tallest * look, cz);
  };
  const aimed = sets.map(targetOf).filter((t): t is RVec => !!t);
  let target = aimed.length
    ? r3(
        (Math.min(...aimed.map((t) => t.x)) + Math.max(...aimed.map((t) => t.x))) / 2,
        (Math.min(...aimed.map((t) => t.y)) + Math.max(...aimed.map((t) => t.y))) / 2,
        (Math.min(...aimed.map((t) => t.z)) + Math.max(...aimed.map((t) => t.z))) / 2,
      )
    : toRideo(o.fallbackTarget ?? [0, 0, 1]);

  // the direction from the target to the camera
  const angle = spec.angle === 'over_shoulder' || spec.angle === 'pov' ? 'three_quarter_left' : spec.angle;
  const turn = ANGLE_DEG[angle] ?? 0;
  let dir: RVec;
  if (figures.length >= 2) {
    let n = turnLeft(norm(flat(sub(figures[1].feet, figures[0].feet))), 90);
    if (line) {
      if (sideOf(line.a, line.b, add(target, mul(n, 3))) !== line.side) n = mul(n, -1);
    } else if (n.z < 0 || (Math.abs(n.z) < 1e-6 && n.x < 0)) n = mul(n, -1);
    dir = turnLeft(n, turn);
  } else if (figures.length === 1) {
    dir = onSide(turnLeft(figures[0].facing, turn), target);
  } else {
    dir = line ? onSide(r3(0, 0, 1), target) : r3(0, 0, 1);
  }

  // across the frame, a group whose subjects move is held where it lets the camera come nearest:
  // the subject needing the most room on the left balanced against the one on the right, nearer
  // ones taking more of the frame (one running ahead does not leave the others small at the far
  // edge). The target keeps the offset rideo's has from that balance at the shot's first frame, so
  // subjects that stay put keep rideo's target
  const right = norm(cross(mul(dir, -1), UP));
  const start = figures.length > 1 && !sets[0].insert ? targetOf(sets[0]) : null;
  if (start) {
    const k = GROUP_MARGIN / tanH;
    // the lateral offset minimising the distance groupFit asks for (the max of a + k|x − s| over
    // the subjects is least where its two sides meet)
    const balance = (fs: readonly Figure[]) => {
      let toLeft = -Infinity;
      let toRight = -Infinity;
      for (const s of fs) {
        const rel = sub(s.feet, flat(target));
        toLeft = Math.max(toLeft, dot(rel, dir) - k * dot(rel, right));
        toRight = Math.max(toRight, dot(rel, dir) + k * dot(rel, right));
      }
      return (toRight - toLeft) / (2 * k);
    };
    const shift = balance(all) - balance(figures) + dot(sub(start, target), right);
    if (shift) target = add(target, mul(right, shift));
  }

  // the distance: the framing's coverage, and every subject of a group inside the frame's width by
  // angle (one nearer the camera than the group's centre covers a wider angle), at every frame
  const groupFit =
    figures.length > 1
      ? Math.max(
          ...all.map((s) => {
            const rel = sub(s.feet, flat(target));
            return dot(rel, dir) + ((Math.abs(dot(rel, right)) + GROUP_PAD_M * scale) / tanH) * GROUP_MARGIN;
          }),
        )
      : 0;
  // an animal: far enough back for what the framing shows of it (all of it from a medium out) to
  // fill at most ANIMAL_ROOM of the frame, at every frame
  const animalFit = Math.max(
    0,
    ...all.flatMap((s) =>
      s.animal
        ? animalShows(s, s.animal, framing).map((p) => {
            const rel = sub(p, target);
            const across = Math.abs(dot(rel, right)) / (ANIMAL_ROOM * tanH);
            return dot(rel, dir) + Math.max(across, Math.abs(rel.y) / (ANIMAL_ROOM * tanV));
          })
        : [],
    ),
  );
  const coverage = FRAMING_TABLE[framing].coverage_m * scale;
  const distance = Math.max(coverage / 2 / tanV, groupFit, animalFit, 0.3);
  const eyes = grounded.length ? Math.max(...grounded.map((s) => s.eyes.y)) : 1.5;
  const head = grounded.length ? Math.max(...grounded.map((s) => s.head.y)) : 1.7;
  const y =
    spec.height === 'low'
      ? floor + 0.4 * Math.max(0.6, scale)
      : spec.height === 'high'
        ? head + 1.2
        : spec.height === 'overhead'
          ? head + 4
          : framing === 'wide' || framing === 'extreme_wide'
            ? Math.max(eyes, floor + 1.5)
            : Math.max(floor + 0.3, eyes);
  const rise = y - target.y;
  const along = Math.sqrt(Math.max(distance * distance - rise * rise, (0.3 * distance) ** 2));
  const pos = add(flat(target), mul(dir, along));
  return placed(r3(pos.x, y, pos.z), target, 'framed');
}

/**
 * A placed camera made final (rideo's solveCamera ends so): backed out of a set piece it would stand
 * in, backwards along its view (water lets cameras in), judged where it will stand: at least 5 cm
 * above the floor (a low camera backing down out of a landmark's floor would be put back inside
 * it; rideo's landmarks reach down without end); then rounded to the millimetre, with its lens and
 * the end of its move.
 */
export function finishCamera(
  scene: DeskScene,
  spec: Pick<SolveSpec, 'lens_mm' | 'move'>,
  frame: number,
  placed: Pick<PlacedCamera, 'position' | 'target'>,
): SolvedCamera {
  const lensMm = clamp(Math.round(spec.lens_mm), 8, 800);
  const target = toRideo(placed.target);
  let p = toRideo(placed.position);
  const back = norm(sub(p, target));
  const solids = scene.solids(frame);
  const inside = (q: RVec) => scene.insideSolid(toEditor(r3(q.x, clamp(q.y, 0.05, 200), q.z)), frame, solids);
  for (let i = 0; i < 40 && inside(p); i++) p = add(p, mul(back, 0.5));
  const start = placement(p, target);
  const startEd = { position: toEditor(start.pos), target: toEditor(start.target) };
  return { ...startEd, lens_mm: lensMm, end: moveEnd(startEd, lensMm, scene.aspect, spec.move) };
}

/**
 * Places a camera from a spec at `frame` (rideo's solveCamera): placeCamera, then finishCamera. With
 * `o.line`, a camera that would stand on the other side of the scene's line is turned back to its
 * side; `o.fallbackTarget` is what a shot without subjects looks at (rideo: 1 m above the origin);
 * `o.over` frames the subjects over more frames (F3).
 */
export function solveCamera(
  scene: DeskScene,
  spec: SolveSpec,
  frame: number,
  o: SolveOptions = {},
): SolvedCamera {
  return finishCamera(scene, spec, frame, placeCamera(scene, spec, frame, o));
}

/**
 * Where a camera move of rideo's library ends (rideo's moveEnd, plus crane_down and dolly_zoom's push),
 * from its start; null for moves without an end placement (pans, tilts, handheld, the moves that
 * follow a subject …). `amount` scales the distance or angle (1 = the library's).
 */
export function moveEnd(
  start: CameraPlacement,
  lensMm: number,
  aspect: number,
  move: DeskMove | null,
  amount = 1,
): CameraPlacement | null {
  if (!move) return null;
  const p = toRideo(start.position);
  const t = toRideo(start.target);
  const b = basis(p, t);
  const toT = sub(t, p);
  const out = (pos: RVec, target: RVec) => {
    const placed = placement(pos, target);
    return { position: toEditor(placed.pos), target: toEditor(placed.target) };
  };
  void lensMm;
  void aspect;
  switch (move) {
    case 'push_in':
    case 'dolly_zoom':
      return out(add(p, mul(toT, PUSH_SHARE * amount)), t);
    case 'pull_out':
      return out(sub(p, mul(toT, PUSH_SHARE * amount)), t);
    case 'dolly_left':
      return out(sub(p, mul(b.right, DOLLY_M * amount)), sub(t, mul(b.right, DOLLY_M * amount)));
    case 'dolly_right':
      return out(add(p, mul(b.right, DOLLY_M * amount)), add(t, mul(b.right, DOLLY_M * amount)));
    case 'orbit_left':
    case 'orbit_right': {
      const v = flat(sub(p, t));
      const r = len(v);
      const k = move === 'orbit_left' ? -1 : 1;
      const a = rad(ORBIT_DEG * amount);
      const turned = add(mul(v, Math.cos(a)), mul(b.right, k * r * Math.sin(a)));
      return out(r3(t.x + turned.x, p.y, t.z + turned.z), t);
    }
    case 'crane_up':
      return out(add(p, r3(0, CRANE_M * amount, 0)), t);
    case 'crane_down':
      return out(sub(p, r3(0, CRANE_M * amount, 0)), t);
    default:
      return null;
  }
}

/** rideo's move ids a blocked camera's start and end placement amount to (rideo's cameraMoveOf). */
export function cameraMoveOf(
  start: CameraPlacement,
  end: CameraPlacement | null,
):
  | 'crane_up'
  | 'crane_down'
  | 'dolly_left'
  | 'dolly_right'
  | 'orbit_left'
  | 'orbit_right'
  | 'push_in'
  | 'pull_out'
  | null {
  if (!end) return null;
  const p = toRideo(start.position);
  const b = basis(p, toRideo(start.target));
  const dp = sub(toRideo(end.position), p);
  const dt = sub(toRideo(end.target), toRideo(start.target));
  const lateral = dot(dp, b.right);
  const forward = dot(flat(dp), norm(flat(b.forward)));
  if (Math.abs(dp.y) > 0.3 && Math.abs(dp.y) >= Math.max(Math.abs(lateral), Math.abs(forward)))
    return dp.y > 0 ? 'crane_up' : 'crane_down';
  if (len(dt) > 0.5 * Math.max(0.01, len(dp)) && Math.abs(lateral) > Math.abs(forward))
    return lateral > 0 ? 'dolly_right' : 'dolly_left';
  if (Math.abs(lateral) > 0.2 && Math.abs(lateral) > Math.abs(forward))
    return lateral > 0 ? 'orbit_right' : 'orbit_left';
  if (Math.abs(forward) > 0.15) return forward > 0 ? 'push_in' : 'pull_out';
  return null;
}

/**
 * Solves the shot's camera from its framing, angle, height, subjects and lens at `frame` (default:
 * its frame_start), without the scene's line. `index`: the shot's place in the cut (default angles).
 */
export function solveShotCamera(
  doc: SceneDoc,
  shot: ShotData,
  o: { frame?: number; aspect?: number; index?: number; line?: LinePoints | null } = {},
): SolvedCamera {
  const scene = new DeskScene(doc, { aspect: o.aspect });
  const spec = shotSpec(scene, shot, o.index ?? 0);
  return solveCamera(scene, spec, o.frame ?? shot.frame_start, { line: o.line ?? null });
}
