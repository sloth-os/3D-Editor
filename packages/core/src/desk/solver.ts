import type { Vec3 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import type { DeskAngle, DeskFraming, DeskHeight, DeskMove, ShotData } from '../doc/types';
import { DeskScene, toEditor, toRideo, type RVec } from './layout';

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
 * a standing person lands where rideo's figure would. Other subjects are rideo's props: the target
 * of an insert. A shot with no actor is framed on its other subjects as if they were figures as tall
 * as their bounds (rideo has no measured props and frames a cast-less shot on a 0.3 m stand-in
 * 1.5 m from the eye); a cast-less insert follows rideo exactly.
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

/** Room kept beside each subject of a group (m, for a 1.7 m figure) and the margin on the angle it needs. */
const GROUP_PAD_M = 0.25;
const GROUP_MARGIN = 1.1;
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
 * Places a camera from a spec at `frame` (rideo's solveCamera). With `line`, a camera that would stand
 * on the other side of the scene's line is turned back to its side. `fallbackTarget`: what a shot
 * without subjects looks at (rideo: 1 m above the origin).
 */
export function solveCamera(
  scene: DeskScene,
  spec: SolveSpec,
  frame: number,
  o: { line?: LinePoints | null; fallbackTarget?: Vec3 } = {},
): SolvedCamera {
  const framing = spec.framing;
  const lensMm = clamp(Math.round(spec.lens_mm), 8, 800);
  const aspect = scene.aspect;
  const tanH = DESK_SENSOR_WIDTH_MM / 2 / Math.max(1, lensMm);
  const tanV = tanH / Math.max(0.1, aspect);
  const measured = spec.subjects
    .map((id) => scene.subject(id, frame))
    .filter((s): s is NonNullable<typeof s> => !!s);
  const actors = measured.filter((s) => s.actor);
  const props = measured.filter((s) => !s.actor);
  const insertProp = framing === 'insert' ? props[0] : undefined;
  // rideo frames characters; a cast-less shot (other than an insert) frames its props as figures
  const figuresFrom = actors.length || insertProp ? actors : props;
  const figures: Figure[] = figuresFrom.map((s) => ({
    id: s.id,
    feet: toRideo(s.feet),
    eyes: toRideo(s.eyes),
    head: toRideo(s.head),
    height: s.height,
    facing: norm(flat(toRideo(s.facing))),
    body: s.posed ? { chest: toRideo(s.chest), eyes: toRideo(s.eyes), head: toRideo(s.head) } : null,
  }));
  const tallest = Math.max(0.3, ...figures.map((s) => s.height));
  const scale = clamp(tallest / 1.7, 0.3, 3);
  const floor = figures.length ? Math.min(...figures.map((s) => s.feet.y)) : 0;
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
  const finish = (pos: RVec, target: RVec): SolvedCamera => {
    // out of a set piece it would stand in, backwards along its view (water lets cameras in), judged
    // where the camera will stand: at least 5 cm above the floor (a low camera backing down out of a
    // landmark's floor would be put back inside it; rideo's landmarks reach down without end)
    let p = pos;
    const back = norm(sub(p, target));
    const solids = scene.solids(frame);
    const inside = (q: RVec) =>
      scene.insideSolid(toEditor(r3(q.x, clamp(q.y, 0.05, 200), q.z)), frame, solids);
    for (let i = 0; i < 40 && inside(p); i++) p = add(p, mul(back, 0.5));
    const start = placement(p, target);
    const startEd = { position: toEditor(start.pos), target: toEditor(start.target) };
    return { ...startEd, lens_mm: lensMm, end: moveEnd(startEd, lensMm, aspect, spec.move) };
  };

  // POV: from the first subject's eyes, where they look (at the second subject when there is one)
  if (spec.angle === 'pov' && figures[0]) {
    const s = figures[0];
    const eyes = add(s.eyes, mul(s.facing, 0.12));
    const target = figures[1] ? figures[1].eyes : add(eyes, mul(s.facing, 4));
    return finish(eyes, target);
  }
  // over the shoulder: behind the first subject's shoulder on the scene's side, at the second subject
  if (spec.angle === 'over_shoulder' && figures.length >= 2) {
    const [fg, bg] = figures as [Figure, Figure];
    const away = norm(flat(sub(fg.feet, bg.feet)));
    const side = onSide(turnLeft(away, 90), fg.feet);
    const pos = add(add(fg.feet, mul(away, 0.55 * scale)), mul(side, 0.32 * scale));
    return finish(r3(pos.x, fg.feet.y + fg.height * 0.86, pos.z), bg.eyes);
  }

  // the target: the subjects' centre at the height the framing looks at (the prop of an insert); a
  // posed body is aimed at where the look share falls on it (a lone one in height too: the face of a
  // close-up wherever its pose puts it)
  const look = FRAMING_TABLE[framing].look;
  let target: RVec;
  if (insertProp) target = toRideo(insertProp.center);
  else if (!figures.length) target = toRideo(o.fallbackTarget ?? [0, 0, 1]);
  else {
    const aims = figures.map((s) => bodyPoint(s, look) ?? s.feet);
    const cx = aims.reduce((n, a) => n + a.x, 0) / figures.length;
    const cz = aims.reduce((n, a) => n + a.z, 0) / figures.length;
    const cy = figures.reduce((n, s) => n + s.feet.y, 0) / figures.length;
    const lone = figures.length === 1 ? bodyPoint(figures[0], look) : null;
    target = r3(cx, lone ? lone.y : cy + tallest * look, cz);
  }

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

  // the distance: the framing's coverage, and every subject of a group inside the frame's width by
  // angle (one nearer the camera than the group's centre covers a wider angle)
  const right = norm(cross(mul(dir, -1), UP));
  const groupFit =
    figures.length > 1
      ? Math.max(
          ...figures.map((s) => {
            const rel = sub(s.feet, flat(target));
            return dot(rel, dir) + ((Math.abs(dot(rel, right)) + GROUP_PAD_M * scale) / tanH) * GROUP_MARGIN;
          }),
        )
      : 0;
  const coverage = FRAMING_TABLE[framing].coverage_m * scale;
  const distance = Math.max(coverage / 2 / tanV, groupFit, 0.3);
  const eyes = figures.length ? Math.max(...figures.map((s) => s.eyes.y)) : 1.5;
  const head = figures.length ? Math.max(...figures.map((s) => s.head.y)) : 1.7;
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
  return finish(r3(pos.x, y, pos.z), target);
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
