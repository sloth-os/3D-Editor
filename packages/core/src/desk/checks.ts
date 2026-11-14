import type { Vec3 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import type { ObjectData, ShotData } from '../doc/types';
import { sanitizeRigidBody, sanitizeRigidBodyWorld } from '../physics/settings';
import { findShotIndex, getDeskSettings, getShots, shotOutputFrames } from './shots';
import { DESK_PROPS } from './props';
import {
  DeskScene,
  boxCenter,
  deskNumber,
  deskProp,
  inPicture,
  projectPoint,
  v3sub,
  type CameraView,
} from './layout';
import { crossesLine, lineOfAction, pairPoints } from './line';
import { TURNING_MOVES, inFrameSamples, shotSamples, shotSpec, unframedSubjects } from './solver';
import { occlusionsThrough } from './moves';
import { RIDE_PREFIX } from './characters/rig';
import { tetherDetachments } from './physics/tether';
import { RIGID_BODY_BAKED_PROP, modelRootOf } from './physics/common';
import { isSimulatedBody } from './physics/bake';
import {
  WATER_LEVEL_M,
  WATER_TOUCH_M,
  WATER_UNDER_M,
  hasWater,
  inSpans,
  inWaterSpans,
  stillWater,
  waterAt,
  waterNear,
  type WaterHit,
  type WaterSurface,
} from './water';
import {
  alignLayoutToPlan,
  layoutView,
  planAgreement,
  shotCameraView,
  type ShotLayoutEntry,
  type ShotView,
} from './plan';

/*
 * Continuity checks and rideo's blocking sentences (spec §7). The checks follow rideo's
 * blockingIssues (line_crossed, subject_out_of_frame, camera_inside, outside_set, plan_mismatch,
 * absent_in_frame, actors_overlap, screen_direction) on the evaluated scene, at each shot's first
 * frame unless said otherwise, and add the desk's own: missing_camera, jump_cut, empty_shot,
 * duration_clamped, physics_unbaked, shot_gap, subject_revealed (a subject a pan or a tilt brings
 * into the frame by its last frame), subject_hidden (a subject put away by a hide key
 * where the shot should show it), occluded_subject (a subject hidden behind an actor the shot
 * does not frame, the solver's own test), tether_detached (a kite's string left behind when
 * its anchor moved after desk.tether_fly keyed the flight), walks_on_water (an actor standing on
 * a lake as on solid ground) and body_in_water (a prop the physics moves in water without floating:
 * water.ts finds the water). Objects put away by a hide key
 * (hide.ts) at a frame are nowhere in it: they leave no frame, stand nowhere and hide nothing. A
 * rider and the mount she sits on move as one: they make no line (line.ts) and cross the frame as
 * one. The blocking line and the moves sentence are rideo's, word for word, with the scene's object
 * names.
 */

export const DESK_ISSUE_CODES = [
  'line_crossed',
  'subject_out_of_frame',
  'camera_inside',
  'missing_camera',
  'plan_mismatch',
  'screen_direction',
  'jump_cut',
  'absent_in_frame',
  'subject_hidden',
  'subject_revealed',
  'occluded_subject',
  'tether_detached',
  'walks_on_water',
  'body_in_water',
  'actors_overlap',
  'outside_set',
  'empty_shot',
  'duration_clamped',
  'physics_unbaked',
  'shot_gap',
] as const;
export type DeskIssueCode = (typeof DESK_ISSUE_CODES)[number];

export type DeskIssueSeverity = 'error' | 'warning' | 'info';

/** The severity of each issue code (spec §7). */
export const DESK_ISSUE_SEVERITY: Readonly<Record<DeskIssueCode, DeskIssueSeverity>> = {
  line_crossed: 'error',
  subject_out_of_frame: 'error',
  camera_inside: 'error',
  missing_camera: 'error',
  tether_detached: 'error',
  walks_on_water: 'error',
  plan_mismatch: 'warning',
  screen_direction: 'warning',
  jump_cut: 'warning',
  absent_in_frame: 'warning',
  subject_hidden: 'warning',
  subject_revealed: 'warning',
  occluded_subject: 'warning',
  body_in_water: 'warning',
  actors_overlap: 'warning',
  outside_set: 'warning',
  empty_shot: 'warning',
  duration_clamped: 'warning',
  physics_unbaked: 'info',
  shot_gap: 'info',
};

export interface DeskIssue {
  code: DeskIssueCode;
  severity: DeskIssueSeverity;
  /** The shot's id (null: the whole scene). */
  shot: string | null;
  /** Object ids involved. */
  objects: string[];
  message: string;
}

/** What desk.check returns. */
export interface DeskCheckResult {
  issues: DeskIssue[];
  /** rideo's blocking sentence of each shot's first frame ('' when it has nothing to say). */
  lines: { shot: string; line: string }[];
  /** Each shot's layout at its first frame. */
  layouts: { shot: string; layout: ShotLayoutEntry[] }[];
  summary: string;
}

/** Two actors closer than this stand in the same place (rideo's OVERLAP_M). */
export const OVERLAP_M = 0.35;
/** A cut between two shots of the same subjects is a jump cut when the camera turns less than this (degrees) … */
export const JUMP_CUT_DEG = 30;
/** … and the subjects keep their size on screen within this ratio. */
export const JUMP_CUT_SIZE_RATIO = 0.7;

const MAX_MESSAGE = 500;

// ---------------------------------------------------------------- sentences

const WHERE: Readonly<Record<ShotLayoutEntry['side'], string>> = {
  left: 'left of frame',
  centre: 'in the centre',
  right: 'right of frame',
};

function facingWords(c: ShotLayoutEntry): string {
  if (c.turn) return `turned three-quarters to the ${c.turn}`;
  switch (c.facing) {
    case 'camera':
      return 'facing the camera';
    case 'away':
      return 'with their back to the camera';
    default:
      return `facing ${c.facing}`;
  }
}

function listOf(items: string[]): string {
  return items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * rideo's blocking line of a view: where everyone (the actors) stands and faces, what is behind them
 * and where the light comes from; '' without actors in frame and landmarks behind.
 */
export function describeView(view: ShotView | null): string {
  if (!view) return '';
  const parts: string[] = [];
  const actors = view.subjects.filter((c) => c.actor);
  const people = actors.filter((c) => c.in_frame);
  const said = people.map(
    (c) =>
      `${c.name} is ${WHERE[c.side]}${c.depth_label ? ` in the ${c.depth_label}` : ''}, ${facingWords(c)}`,
  );
  const edges = actors.filter((c) => c.edge).map((c) => `${c.name}'s shoulder in the ${c.edge} foreground`);
  if (said.length) parts.push(`Blocking: ${said.join('; ')}${edges.length ? `, ${listOf(edges)}` : ''}.`);
  if (view.behind.length)
    parts.push(`Behind ${people.length ? 'them' : 'the frame'}: ${listOf(view.behind)}.`);
  if (!parts.length) return '';
  const source = view.interior ? 'the key light' : 'the sun';
  const light =
    view.light === 'behind'
      ? `${source} is behind the camera${view.light_side ? `, on the ${view.light_side}` : ''}`
      : view.light === 'ahead'
        ? `${source} is ahead of the camera, behind the scene`
        : `${source} comes from the ${view.light}`;
  parts.push(`Light: ${light}.`);
  return parts.join(' ');
}

/** rideo's moves sentence of a view: "Ada walks from left of frame to the centre." ('' when nobody moves). */
export function describeMoves(view: ShotView | null): string {
  if (!view) return '';
  const moves = view.subjects
    .filter((c) => c.actor && c.in_frame && c.to)
    .map((c) => {
      const to = c.to!;
      if (to.toward) return `${c.name} walks ${to.toward === 'camera' ? 'towards' : 'away from'} the camera.`;
      if (to.side === c.side) return null;
      return `${c.name} walks from ${WHERE[c.side]} to ${to.side === 'centre' ? 'the centre' : WHERE[to.side]}.`;
    })
    .filter((m): m is string => !!m);
  return moves.join(' ');
}

/**
 * The view of a shot at `frame` in the plan's words (rideo's blockingView lines: a subject a little
 * off centre on its planned side is said to be there).
 */
function plannedView(scene: DeskScene, shot: ShotData, frame: number): ShotView | null {
  const view = layoutView(scene, shot, frame, shotCameraView(scene, shot, frame));
  return view && { ...view, subjects: alignLayoutToPlan(view.subjects, shot.layout) };
}

/**
 * rideo's blocking sentence for the shot at `frame`, e.g. "Blocking: Ada is left of frame in the
 * foreground, facing right; Ben is right of frame, facing the camera. Behind them: the lake.
 * Light: the sun is behind the camera, on the left." ('' without a camera or anything to say).
 */
export function blockingLine(
  doc: SceneDoc,
  shot: ShotData,
  frame: number,
  scene = new DeskScene(doc),
): string {
  return describeView(plannedView(scene, shot, frame));
}

/** rideo's moves sentence for the shot (its first frame to its last), e.g. "Ada walks from left of frame to the centre." */
export function blockingMoves(doc: SceneDoc, shot: ShotData, scene = new DeskScene(doc)): string {
  return describeMoves(plannedView(scene, shot, shot.frame_start));
}

// ---------------------------------------------------------------- checks

const shotLabel = (s: ShotData): string => `'${s.name}'`;

/** 'frame 3' or 'frames 3, 25, 48'. */
const framesWord = (frames: readonly number[]): string =>
  `frame${frames.length > 1 ? 's' : ''} ${frames.join(', ')}`;

/** The most frames of a shot tether_detached samples (about four a second, fewer in long shots). */
const DETACH_SAMPLES = 48;

/** The frames of a shot where tether_detached looks for strings left behind by their anchor. */
function detachSamples(s: ShotData, fps: number): number[] {
  const span = s.frame_end - s.frame_start;
  const step = Math.max(1, Math.round(fps / 4), Math.ceil(span / (DETACH_SAMPLES - 1)));
  const frames: number[] = [];
  for (let f = s.frame_start; f < s.frame_end; f += step) frames.push(f);
  frames.push(s.frame_end);
  return frames;
}

function issue(code: DeskIssueCode, shot: string | null, objects: string[], message: string): DeskIssue {
  return {
    code,
    severity: DESK_ISSUE_SEVERITY[code],
    shot,
    objects: [...new Set(objects)],
    message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message,
  };
}

/** Horizontal angle (degrees) between two floor directions. */
function angleBetween(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  const la = Math.hypot(a[0], a[1]);
  const lb = Math.hypot(b[0], b[1]);
  if (la < 1e-9 || lb < 1e-9) return 0;
  const c = (a[0] * b[0] + a[1] * b[1]) / (la * lb);
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}

/** The subjects' screen height (share of the frame's height) through `view` at `frame`: the tallest. */
function screenSize(scene: DeskScene, view: CameraView, subjects: readonly string[], frame: number): number {
  let size = 0;
  for (const id of subjects) {
    const s = scene.subject(id, frame);
    if (!s || s.hidden) continue;
    const top = projectPoint(view, s.head);
    const bottom = projectPoint(view, s.feet);
    if (Number.isFinite(top.y) && Number.isFinite(bottom.y))
      size = Math.max(size, Math.abs(top.y - bottom.y) / 2);
  }
  return size;
}

/** The centre of the subjects' feet at `frame` (null when none is there, or shown). */
function centroid(scene: DeskScene, subjects: readonly string[], frame: number): Vec3 | null {
  const pts = subjects
    .map((id) => scene.subject(id, frame))
    .filter((s): s is NonNullable<typeof s> => !!s && !s.hidden)
    .map((s) => s.feet);
  if (!pts.length) return null;
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) c[k] += p[k] / pts.length;
  return c;
}

/** The direction (+1 right, −1 left, 0 none) an actor crosses the frame during a shot, through its first frame's camera. */
function crossing(scene: DeskScene, shot: ShotData, id: string): -1 | 0 | 1 {
  if (!shot.camera) return 0;
  const view = scene.camera(shot.camera, shot.frame_start);
  const a = scene.subject(id, shot.frame_start);
  const b = scene.subject(id, shot.frame_end);
  if (!view || !a || !b || a.hidden || b.hidden || shot.frame_end === shot.frame_start) return 0;
  const pa = projectPoint(view, a.chest);
  const pb = projectPoint(view, b.chest);
  return Number.isFinite(pa.x) && Number.isFinite(pb.x) && Math.abs(pb.x - pa.x) > 0.15
    ? (Math.sign(pb.x - pa.x) as -1 | 1)
    : 0;
}

/**
 * Runs the continuity checks over `shots` (ids or names; default: every enabled shot), returning the
 * issues, each shot's blocking line and layout at its first frame, and a summary. Relations between
 * shots (the line's side, screen direction, jump cuts, gaps) are judged over the enabled shots in cut
 * order and reported on the checked ones.
 */
export function checkShots(doc: SceneDoc, o: { shots?: readonly string[] } = {}): DeskCheckResult {
  const scene = new DeskScene(doc);
  const all = getShots(doc);
  const cut = all.filter((s) => s.enabled);
  let checked: ShotData[];
  if (o.shots?.length) {
    const seen = new Set<string>();
    checked = [];
    for (const ref of o.shots) {
      const i = findShotIndex(all, ref);
      if (i >= 0 && !seen.has(all[i].id)) {
        seen.add(all[i].id);
        checked.push(all[i]);
      }
    }
  } else checked = cut;
  const isChecked = new Set(checked.map((s) => s.id));
  const issues: DeskIssue[] = [];
  const lines: DeskCheckResult['lines'] = [];
  const layouts: DeskCheckResult['layouts'] = [];
  const line = lineOfAction(scene, cut);
  const desk = getDeskSettings(doc);
  const fps = Math.max(1, doc.getScene().fps || 24);
  const actors = scene.actorIds();
  const name = (id: string) => scene.name(id);
  // the water checks (nothing to do without water): where each actor stands, read once per frame
  const water = hasWater(doc);
  const still = water ? stillWater(scene) : null;
  const bodies = water ? physicsBodies(scene).filter((b) => mayReachWater(scene, b.id, still)) : [];
  const grounds = new Map<string, Vec3 | null>();
  const ground = (id: string, f: number): Vec3 | null => {
    const key = `${id}@${f}`;
    let p = grounds.get(key);
    if (p === undefined) grounds.set(key, (p = actorGround(scene, id, f)));
    return p;
  };

  for (const s of checked) {
    const frame = s.frame_start;
    if (!s.subjects.length)
      issues.push(
        issue(
          'empty_shot',
          s.id,
          [],
          `Shot ${shotLabel(s)} has no subjects: the solver cannot frame it and the checks cannot follow it`,
        ),
      );
    const seconds = shotOutputFrames(s) / fps;
    if (desk.max_shot_s !== null && seconds > desk.max_shot_s + 1e-9)
      issues.push(
        issue(
          'duration_clamped',
          s.id,
          [],
          `Shot ${shotLabel(s)} lasts ${seconds.toFixed(2)} s; the video model makes at most ${desk.max_shot_s} s (trim it, or export with match_model_duration)`,
        ),
      );
    if (desk.min_shot_s !== null && seconds < desk.min_shot_s - 1e-9)
      issues.push(
        issue(
          'duration_clamped',
          s.id,
          [],
          `Shot ${shotLabel(s)} lasts ${seconds.toFixed(2)} s; the video model makes at least ${desk.min_shot_s} s (lengthen it, or export with match_model_duration)`,
        ),
      );
    if (desk.set_width > 0 && desk.set_depth > 0) {
      const halfW = desk.set_width / 2 + 0.01;
      const halfD = desk.set_depth / 2 + 0.01;
      for (const id of s.subjects) {
        if (!scene.isActor(id)) continue;
        const sub = scene.subject(id, frame);
        if (sub && !sub.hidden && (Math.abs(sub.feet[0]) > halfW || Math.abs(sub.feet[1]) > halfD))
          issues.push(
            issue('outside_set', s.id, [id], `${name(id)} stands outside the set in shot ${shotLabel(s)}`),
          );
      }
    }
    const here = s.subjects.filter((id) => scene.isActor(id));
    for (let i = 0; i < here.length; i++)
      for (let j = i + 1; j < here.length; j++) {
        const a = scene.subject(here[i], frame);
        const b = scene.subject(here[j], frame);
        // a rider above its mount does not stand in its place; one put away stands nowhere
        if (
          a &&
          b &&
          !a.hidden &&
          !b.hidden &&
          Math.hypot(a.feet[0] - b.feet[0], a.feet[1] - b.feet[1]) < OVERLAP_M &&
          Math.abs(a.feet[2] - b.feet[2]) < 0.5
        )
          issues.push(
            issue(
              'actors_overlap',
              s.id,
              [here[i], here[j]],
              `${name(here[i])} and ${name(here[j])} stand in the same place in shot ${shotLabel(s)}`,
            ),
          );
      }
    // a kite's string left behind where its anchor was when desk.tether_fly keyed the flight
    for (const d of tetherDetachments(doc, detachSamples(s, fps))) {
      const first = d.frames[0];
      const last = d.frames[d.frames.length - 1];
      const tied = d.bone ? `${name(d.anchor)}'s ${d.bone}` : name(d.anchor);
      issues.push(
        issue(
          'tether_detached',
          s.id,
          [d.string, d.flyer, d.anchor],
          `The string of ${name(d.flyer)} is not tied to ${tied} in shot ${shotLabel(s)} (${last > first ? `frames ${first}–${last}` : `frame ${first}`}, up to ${d.gap.toFixed(2)} m away): ` +
            `${name(d.anchor)} moved after desk.tether_fly keyed the flight. Run desk.tether_fly again (the same options) after the anchor's moves, so that the string follows`,
        ),
      );
    }
    if (!s.camera) {
      issues.push(issue('missing_camera', s.id, [], `Shot ${shotLabel(s)} has no camera`));
      lines.push({ shot: s.id, line: '' });
      layouts.push({ shot: s.id, layout: [] });
      continue;
    }
    const cam = s.camera;
    const view = scene.camera(cam, frame);
    const shown = layoutView(scene, s, frame, view);
    layouts.push({ shot: s.id, layout: shown?.subjects ?? [] });
    lines.push({
      shot: s.id,
      line: describeView(shown && { ...shown, subjects: alignLayoutToPlan(shown.subjects, s.layout) }),
    });
    if (line && crossesLine(scene, line, s))
      issues.push(
        issue(
          'line_crossed',
          s.id,
          [cam, line.a, line.b],
          `The camera of shot ${shotLabel(s)} crossed the line between ${name(line.a)} and ${name(line.b)}: they swap sides on the cut`,
        ),
      );
    // subjects a shot leaves out of its frame by design (by the angle and framing the solver frames
    // the shot with, its own or their defaults: the shoulder, a viewer, an insert's cast), at its
    // first, middle and last frames (its first only for moves that turn away; the solver keeps the
    // subjects in frame over the same frames)
    // a subject put away by a hide key at such a frame is not in the picture by design or by
    // mistake: said as hidden (subject_hidden), not as out of frame
    const unframed = unframedSubjects(scene, s.subjects, shotSpec(scene, s, all.indexOf(s)));
    const frames = inFrameSamples(s);
    // a pan or a tilt may also bring a subject in (a reveal): one out of frame at its first frame and
    // in it at its last is revealed (a warning), not out of frame
    const turning = !!s.move && TURNING_MOVES.has(s.move) && s.frame_end > s.frame_start;
    const inFrameAt = (id: string, f: number): boolean | null => {
      const v = scene.camera(cam, f);
      const sub = scene.subject(id, f);
      if (!v || !sub || sub.hidden) return null;
      const p = projectPoint(v, sub.actor ? sub.eyes : sub.center);
      return Number.isFinite(p.x) && Math.abs(p.x) <= 1 && p.y >= -1 && p.y <= 1.15;
    };
    for (const id of s.subjects) {
      if (unframed.has(id)) continue;
      const out: number[] = [];
      const hidden: number[] = [];
      for (const f of frames) {
        const v = scene.camera(cam, f);
        const sub = scene.subject(id, f);
        if (!v || !sub) continue;
        if (sub.hidden) {
          hidden.push(f);
          continue;
        }
        if (!inFrameAt(id, f)) out.push(f);
      }
      if (turning && out.length) {
        if (inFrameAt(id, s.frame_end)) {
          issues.push(
            issue(
              'subject_revealed',
              s.id,
              [id],
              `${name(id)} comes into the frame of shot ${shotLabel(s)} only as its ${s.move} ends (out of it at ` +
                `${framesWord(out)}, in it at frame ${s.frame_end}): the move reveals it; frame it from the start ` +
                'if it should be seen throughout',
            ),
          );
          out.length = 0;
        } else out.push(s.frame_end);
      }
      if (hidden.length)
        issues.push(
          issue(
            'subject_hidden',
            s.id,
            [id],
            `${name(id)} is hidden in shot ${shotLabel(s)} (${framesWord(hidden)}): it is scaled to nothing there ` +
              "(put away: desk.tether_fly's after 'hide', or an actor the rideo import hides in shots it is not " +
              "cast in), so the shot does not show it; take it out of the shot's subjects, or show it again",
          ),
        );
      if (out.length)
        issues.push(
          issue(
            'subject_out_of_frame',
            s.id,
            [id],
            `${name(id)} is not in the frame of shot ${shotLabel(s)} (${framesWord(out)})`,
          ),
        );
    }
    const insideAt: number[] = [];
    let inside: { owner: string; label: string } | null = null;
    for (const f of shotSamples(s)) {
      const v = scene.camera(cam, f);
      if (!v) continue;
      const hit = scene.insideSolid(v.position, f) ?? belowGround(scene, v.position);
      if (hit) {
        inside ??= hit;
        insideAt.push(f);
      }
    }
    if (inside)
      issues.push(
        issue(
          'camera_inside',
          s.id,
          [cam, inside.owner],
          `The camera of shot ${shotLabel(s)} stands inside ${inside.label} (frame${insideAt.length > 1 ? 's' : ''} ${insideAt.join(', ')})`,
        ),
      );
    const plan = planAgreement(shown?.subjects ?? null, s.layout);
    if (!plan.agrees)
      issues.push(
        issue(
          'plan_mismatch',
          s.id,
          plan.mismatched,
          `The camera of shot ${shotLabel(s)} disagrees with its plan: ${plan.misses.slice(0, 2).join('; ')}`,
        ),
      );
    if (view)
      for (const id of actors) {
        if (s.subjects.includes(id)) continue;
        const o = scene.objects.get(id);
        if (!o || o.hide_render) continue;
        const sub = scene.subject(id, frame);
        // one put away by a hide key there (an actor the rideo import hides) shows nowhere
        if (sub && !sub.hidden && inPicture(projectPoint(view, sub.chest), 0.9))
          issues.push(
            issue(
              'absent_in_frame',
              s.id,
              [id],
              `${name(id)} is not in shot ${shotLabel(s)} but stands in its frame`,
            ),
          );
      }
    // subjects hidden behind an actor the shot does not frame, through the camera as keyed, at the
    // same frames (the solver's test: moves.ts shotOcclusions)
    for (const o of occlusionsThrough(
      scene,
      s.subjects,
      frames,
      frames.map((f) => scene.camera(cam, f)),
    )) {
      const by = o.by.join(' and ');
      const what = o.frames.length
        ? `${o.name} (${framesWord(o.frames)}${o.body_frames.length ? `; the body only at ${framesWord(o.body_frames)}` : ''})`
        : `The body of ${o.name} (${framesWord(o.body_frames)})`;
      issues.push(
        issue(
          'occluded_subject',
          s.id,
          [o.subject, ...o.by_ids],
          `${what} is hidden behind ${by}, who ${o.by.length > 1 ? 'are' : 'is'} not in shot ${shotLabel(s)}: ` +
            `restage, add ${by} to its subjects, or choose another angle or height`,
        ),
      );
    }
    // actors standing on water and bodies in it without floating, at the frames the shot shows them
    if (water) {
      const samples = waterSamples(s, fps);
      issues.push(...walksOnWater(scene, s, cam, samples, ground, still));
      if (bodies.length) issues.push(...bodiesInWater(scene, s, cam, samples, bodies));
    }
  }

  // between consecutive shots of the cut
  for (let i = 1; i < cut.length; i++) {
    const prev = cut[i - 1];
    const s = cut[i];
    if (!isChecked.has(s.id)) continue;
    if (s.continuity !== 'continuous') {
      const shared = s.subjects.filter((c) => prev.subjects.includes(c) && scene.isActor(c));
      for (const id of shared) {
        // a rider crosses the frame with the mount she sits on: the pair is judged once, by the mount
        const mount = scene.mountOf(id, prev.frame_start) ?? scene.mountOf(id, s.frame_start);
        if (mount && shared.includes(mount)) continue;
        const a = crossing(scene, prev, id);
        const b = crossing(scene, s, id);
        if (a !== 0 && b !== 0 && a !== b)
          issues.push(
            issue(
              'screen_direction',
              s.id,
              [id],
              `${name(id)} crosses the frame the other way in shot ${shotLabel(s)} than in shot ${shotLabel(prev)}`,
            ),
          );
      }
    }
    const jump = jumpCut(scene, prev, s);
    if (jump)
      issues.push(
        issue(
          'jump_cut',
          s.id,
          s.subjects,
          `The cut from shot ${shotLabel(prev)} to shot ${shotLabel(s)} is a jump cut: the same subjects, the camera turned ${jump.toFixed(0)}° (less than ${JUMP_CUT_DEG}°) and a similar framing`,
        ),
      );
    const gap = s.frame_start - (prev.frame_end + 1);
    if (gap > s.pre_roll)
      issues.push(
        issue(
          'shot_gap',
          s.id,
          [],
          `${gap} scene frame${gap > 1 ? 's' : ''} between shot ${shotLabel(prev)} (ends at ${prev.frame_end}) and shot ${shotLabel(s)} (starts at ${s.frame_start}) are not in the cut${s.continuity === 'continuous' ? ', although the action continues' : ''}`,
        ),
      );
  }

  const unbaked = unbakedBodies(doc, scene);
  if (unbaked.length)
    issues.push(
      issue(
        'physics_unbaked',
        null,
        unbaked,
        `${unbaked.length} rigid bod${unbaked.length > 1 ? 'ies are' : 'y is'} simulated live (${unbaked
          .slice(0, 5)
          .map(name)
          .join(
            ', ',
          )}${unbaked.length > 5 ? ' …' : ''}): bake them (desk.physics_bake) so every render of the cut shows the same motion`,
      ),
    );

  return { issues, lines, layouts, summary: summarize(checked.length, issues) };
}

// ---------------------------------------------------------------- water

/**
 * The most frames between two samples of the water checks: a half-second crossing at 24 fps is seen
 * twice; the frames where a stretch on water starts and ends are then found to the frame, and an
 * actor its own keys place is read on every frame between two samples near water (crossingFrames),
 * so a shorter crossing is seen too.
 */
export const WATER_SAMPLE_FRAMES = 6;

/** How far above the water's surface (m) the lowest point of an actor clears it in a jump. */
export const WATER_JUMP_M = 0.1;

/** A stretch of frames over one water piece. */
interface WaterRun {
  from: number;
  to: number;
  hit: WaterHit;
}

/** The frames of a shot the water checks sample: every WATER_SAMPLE_FRAMES or fewer, and its last. */
function waterSamples(s: ShotData, fps: number): number[] {
  const step = Math.max(1, Math.min(WATER_SAMPLE_FRAMES, Math.round(fps / 4)));
  const frames: number[] = [];
  for (let f = s.frame_start; f < s.frame_end; f += step) frames.push(f);
  frames.push(s.frame_end);
  return frames;
}

/**
 * The stretches of `frames` (a shot's samples, in order) at which `at` finds water, merged over
 * neighbouring samples on the same piece; where a stretch starts or ends between two samples, the
 * frame is found by bisection.
 */
function waterRuns(frames: readonly number[], at: (frame: number) => WaterHit | null): WaterRun[] {
  const hits = frames.map(at);
  const runs: WaterRun[] = [];
  for (let i = 0; i < frames.length; i++) {
    const hit = hits[i];
    if (!hit) continue;
    let j = i;
    while (j + 1 < frames.length && hits[j + 1]?.id === hit.id) j++;
    let from = frames[i];
    if (i > 0)
      for (let lo = frames[i - 1], hi = from; hi - lo > 1;) {
        const mid = Math.floor((lo + hi) / 2);
        if (at(mid)?.id === hit.id) hi = from = mid;
        else lo = mid;
      }
    let to = frames[j];
    if (j + 1 < frames.length)
      for (let lo = to, hi = frames[j + 1]; hi - lo > 1;) {
        const mid = Math.floor((lo + hi) / 2);
        if (at(mid)?.id === hit.id) lo = to = mid;
        else hi = mid;
      }
    runs.push({ from, to, hit });
    i = j;
  }
  return runs;
}

/** 'frame 3' or 'frames 3–9, 20–31' of stretches. */
const runsWord = (runs: readonly WaterRun[]): string =>
  runs.length === 1 && runs[0].from === runs[0].to
    ? `frame ${runs[0].from}`
    : `frames ${runs.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}–${r.to}`)).join(', ')}`;

/** The stretches by water piece, in the order the pieces are first met. */
function byPiece(runs: readonly WaterRun[]): WaterRun[][] {
  const groups = new Map<string, WaterRun[]>();
  for (const r of runs) {
    const g = groups.get(r.hit.id);
    if (g) g.push(r);
    else groups.set(r.hit.id, [r]);
  }
  return [...groups.values()];
}

/**
 * The influence of the strongest unmuted ride (desk.actor_mount's CHILD_OF) on actor `o` at `frame`;
 * null when a driver writes it (read the actor from a frame state).
 */
function rideInfluence(scene: DeskScene, o: ObjectData, frame: number): number | null {
  let most = 0;
  for (const c of o.constraints) {
    if (c.type !== 'CHILD_OF' || !c.name.startsWith(RIDE_PREFIX) || c.mute) continue;
    const v = scene.channel(o.id, `constraints["${c.name}"].influence`, 0, frame);
    if (v === null) return null;
    most = Math.max(most, v ?? c.influence ?? 1);
  }
  return most;
}

/** Constraints that put their owner where their target is: one holding an actor makes its target carry it. */
const PLACING: ReadonlySet<string> = new Set(['CHILD_OF', 'COPY_LOCATION', 'COPY_TRANSFORMS']);

/**
 * Whether object `x` carries what hangs from it (or is held to it): anything but a plain empty (one
 * that is no desk piece and no store model root, a mere handle that moves its children): a boat or a
 * cart, its saddle empty under its root, another actor.
 */
function carries(scene: DeskScene, x: ObjectData | undefined): boolean {
  const seen = new Set<string>();
  for (let cur = x; cur && !seen.has(cur.id); cur = cur.parent ? scene.objects.get(cur.parent) : undefined) {
    seen.add(cur.id);
    if (cur.type !== 'EMPTY' || deskProp(cur, DESK_PROPS.role) || deskProp(cur, DESK_PROPS.storeId))
      return true;
  }
  return false;
}

/**
 * Whether something carries actor `o` at `frame`, so that it stands on that, not on the ground: a
 * parent that carries (carries), or a constraint other than the desk's rides (read on their own) that
 * holds it to one (CHILD_OF, COPY_LOCATION, COPY_TRANSFORMS at an influence of ½ or more): a rower
 * parented to her rowboat or to its seat, a child on a carrier's shoulders.
 */
function carried(scene: DeskScene, o: ObjectData, frame: number): boolean {
  if (o.parent && carries(scene, scene.objects.get(o.parent))) return true;
  for (const c of o.constraints) {
    if (c.mute || !c.target || !PLACING.has(c.type) || c.name.startsWith(RIDE_PREFIX)) continue;
    const v = scene.channel(o.id, `constraints["${c.name}"].influence`, 0, frame);
    if ((v ?? c.influence ?? 1) >= 0.5 && carries(scene, scene.objects.get(c.target))) return true;
  }
  return false;
}

/**
 * Where an actor's own location keys put it at `frame` (its origin), when nothing else places it (no
 * parent, no driver, only rides that do not hold it then): cheap to read at every frame. Null while
 * it stands on nothing of its own (it rides, or something carries it); undefined when more places it
 * (read it from the scene: actorGround).
 */
function ownGround(scene: DeskScene, id: string, frame: number): Vec3 | null | undefined {
  const o = scene.objects.get(id);
  if (!o || carried(scene, o, frame)) return null;
  const ride = rideInfluence(scene, o, frame);
  if (ride !== null && ride >= 0.5) return null;
  const own =
    ride === 0 &&
    !o.parent &&
    o.constraints.every((c) => c.mute || (c.type === 'CHILD_OF' && c.name.startsWith(RIDE_PREFIX)));
  if (!own) return undefined;
  const p: Vec3 = [o.location[0], o.location[1], o.location[2]];
  for (let i = 0; i < 3; i++) {
    const v = scene.channel(id, 'location', i, frame);
    if (v === null) return undefined;
    if (v !== undefined) p[i] = v;
  }
  return p;
}

/**
 * Where an actor stands at `frame` for the water check: its origin (ownGround, else as the scene
 * evaluates it); null while it stands on nothing of its own: it rides (its mount stands for both) or
 * something else carries it (a boat, a cart, another actor: that stands for it).
 */
function actorGround(scene: DeskScene, id: string, frame: number): Vec3 | null {
  const own = ownGround(scene, id, frame);
  if (own !== undefined) return own;
  // a mount's own CHILD_OF half held, an empty it hangs from, a driver: as the scene evaluates it
  if (scene.mountOf(id, frame)) return null;
  return scene.origin(id, frame);
}

/**
 * Whether renders draw actor `id`: one of its meshes (its parts, below it; other actors' left out)
 * is drawn, by its own hide_render (a render does not inherit it from a parent, eval/evaluate.ts).
 */
function rendersActor(scene: DeskScene, id: string): boolean {
  const stack = [id];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const o = scene.objects.get(cur);
    if (!o || (cur !== id && scene.isActor(cur))) continue;
    if (o.type === 'MESH' && !o.hide_render) return true;
    stack.push(...scene.children(cur));
  }
  return false;
}

/** How far around the chord between two samples (m, at least) a move bends on its way between them. */
const BEND_M = 0.5;

/**
 * The frames between consecutive `samples` (in order) at which actor `id`, placed there by its own
 * keys (ownGround), starts or stops standing on water (`wet`): the frames on both sides of each
 * change, so that a stretch on water shorter than the sample step (a dash across a ditch) is read.
 * Stretches between two samples whose chord, widened by BEND_M or half its length, comes near no
 * still water (`still`; null when a piece moves: every stretch is read) are not read.
 */
function crossingFrames(
  scene: DeskScene,
  id: string,
  samples: readonly number[],
  still: readonly WaterSurface[] | null,
  wet: (frame: number) => WaterHit | null,
): number[] {
  const out: number[] = [];
  for (let k = 0; k + 1 < samples.length; k++) {
    const a = samples[k];
    const b = samples[k + 1];
    if (b - a < 2) continue;
    const pa = ownGround(scene, id, a);
    const pb = ownGround(scene, id, b);
    if (!pa || !pb) continue;
    if (still) {
      const pad = Math.max(BEND_M, Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) / 2);
      const x0 = Math.min(pa[0], pb[0]) - pad;
      const x1 = Math.max(pa[0], pb[0]) + pad;
      const y0 = Math.min(pa[1], pb[1]) - pad;
      const y1 = Math.max(pa[1], pb[1]) + pad;
      if (!still.some((w) => x0 <= w.max[0] && x1 >= w.min[0] && y0 <= w.max[1] && y1 >= w.min[1])) continue;
    }
    // every frame next to a change (onto the water, off it, from one piece to another), so that the
    // stretches between the samples are read as they are
    let prev = wet(a)?.id ?? null;
    for (let f = a + 1; f < b; f++) {
      if (ownGround(scene, id, f) === undefined) break;
      const cur = wet(f)?.id ?? null;
      const next = wet(f + 1)?.id ?? null;
      if (cur !== prev || cur !== next) out.push(f);
      prev = cur;
    }
  }
  return out;
}

/**
 * walks_on_water: the actors that stand on water in a shot's frame: their mark (the actor object's
 * origin, where locomotion puts their feet) over a water piece whose surface is at their floor's
 * level (WATER_LEVEL_M: not a stream under a bridge), at frames the shot shows them (feet, chest or
 * head in the picture). An actor that belongs in the water then (desk_in_water: a swimmer, a wader)
 * is left alone, as are a rider (her mount stands for her), an actor something else carries (a
 * rower in her boat), one renders do not draw, one put away by a hide key (it stands nowhere) and
 * one whose lowest point clears the surface by WATER_JUMP_M (a jump). Every actor in the picture
 * counts, not only the shot's subjects. Actors are read at the shot's samples, and an actor its own
 * keys place on every frame between two samples near water (crossingFrames), so a dash across a
 * ditch between two samples is seen.
 */
function walksOnWater(
  scene: DeskScene,
  s: ShotData,
  cam: string,
  frames: readonly number[],
  ground: (id: string, frame: number) => Vec3 | null,
  still: readonly WaterSurface[] | null,
): DeskIssue[] {
  const out: DeskIssue[] = [];
  for (const id of scene.actorIds()) {
    if (!rendersActor(scene, id)) continue;
    const meant = inWaterSpans(scene.objects.get(id));
    // standing on water at its level, by its mark alone (cheap)
    const wet = (f: number): WaterHit | null => {
      if (inSpans(meant, f)) return null;
      const p = ground(id, f);
      return p && waterAt(scene, p, f, { level: WATER_LEVEL_M });
    };
    const at = (f: number): WaterHit | null => {
      const hit = wet(f);
      if (!hit || scene.hidden(id, f)) return null;
      const sub = scene.subject(id, f);
      const view = scene.camera(cam, f);
      if (!sub || !view || sub.bounds.min[2] > hit.surface_z + WATER_JUMP_M) return null;
      return [sub.feet, sub.chest, sub.head].some((q) => inPicture(projectPoint(view, q))) ? hit : null;
    };
    const extra = crossingFrames(scene, id, frames, still, wet);
    const read = extra.length ? [...new Set([...frames, ...extra])].sort((a, b) => a - b) : frames;
    for (const runs of byPiece(waterRuns(read, at))) {
      const water = runs[0].hit;
      out.push(
        issue(
          'walks_on_water',
          s.id,
          [id, water.owner],
          `${scene.name(id)} stands on the water of ${water.label} in shot ${shotLabel(s)} (${runsWord(runs)}) as if ` +
            "it were solid ground: route the move around it with desk.actor_move points (or raise them onto a bridge's " +
            'deck), or move the mark; for a swimmer or a wader, key the move with in_water: true (desk.actor_move, ' +
            'or desk.actor_add for one that stays in the water)',
        ),
      );
    }
  }
  return out;
}

/** A desk physics body: baked by a bake (its keys) or simulated live, and the frame it floats from (null: never). */
interface WaterBody {
  id: string;
  baked: boolean;
  floats: number | null;
  /**
   * How far its geometry reaches from its origin (m, in its own units: times its world scale), or
   * null when meshes below it move with it (its bounds are measured at every frame read).
   */
  reach: number | null;
}

/** The scene's physics bodies: baked ones (rigid_body_baked) and those the simulation moves. */
function physicsBodies(scene: DeskScene): WaterBody[] {
  const out: WaterBody[] = [];
  for (const o of scene.objects.values()) {
    if (o.type !== 'MESH') continue;
    const baked = !!o.custom_props && RIGID_BODY_BAKED_PROP in o.custom_props;
    if (!baked && !isSimulatedBody(o)) continue;
    let reach: number | null = null;
    const mesh = o.data && !scene.children(o.id).length ? scene.doc.getMesh(o.data) : null;
    if (mesh) {
      reach = 0;
      const p = mesh.positions;
      for (let i = 0; i + 2 < p.length; i += 3) reach = Math.max(reach, Math.hypot(p[i], p[i + 1], p[i + 2]));
    }
    out.push({ id: o.id, baked, floats: deskNumber(o, DESK_PROPS.floats), reach });
  }
  return out;
}

/**
 * Whether body `b` may be in water at `frame`, from its origin and reach alone (cheap): water within
 * its reach of its origin across the floor, at a height its geometry could touch (WATER_TOUCH_M above
 * its lowest point at most) or be over (WATER_UNDER_M under its highest at most). False: it is not
 * in water, whatever its bounds; true: they decide.
 */
function mayBeInWater(scene: DeskScene, b: WaterBody, frame: number): boolean {
  if (b.reach === null) return true;
  const m = scene.world(b.id, frame);
  const scale = Math.max(
    Math.hypot(m[0], m[1], m[2]),
    Math.hypot(m[4], m[5], m[6]),
    Math.hypot(m[8], m[9], m[10]),
  );
  const r = b.reach * scale;
  if (!Number.isFinite(r)) return true;
  return waterNear(
    scene,
    [m[12] - r, m[13] - r],
    [m[12] + r, m[13] + r],
    m[14] - r - WATER_TOUCH_M,
    m[14] + r + WATER_UNDER_M,
    frame,
  );
}

/** A box on the floor (XY). */
interface FloorBox {
  min: [number, number];
  max: [number, number];
}

/**
 * Whether body `id` may come over water: false only when no footprint of still water (`water`, null
 * when a piece moves) meets the floor box its keys hold it in (keyedReach). It spares the reading,
 * frame by frame, of the bodies baked far from any water.
 */
function mayReachWater(scene: DeskScene, id: string, water: readonly WaterSurface[] | null): boolean {
  if (!water) return true;
  const reach = keyedReach(scene, id);
  return (
    !reach ||
    water.some(
      (w) =>
        reach.min[0] <= w.max[0] &&
        reach.max[0] >= w.min[0] &&
        reach.min[1] <= w.max[1] &&
        reach.max[1] >= w.min[1],
    )
  );
}

/**
 * The floor box body `id`'s geometry stays in at every frame, from the keys of its own channels and
 * its parents' alone: each location within the values its keys take (a Bezier segment stays within
 * its control points, which lie at most a third of the curve's range beyond them), any rotation, the
 * largest scale. Null when more than those channels moves it (DeskScene.motionSpan), when objects
 * below it could move on their own, or without geometry.
 */
function keyedReach(scene: DeskScene, id: string): FloorBox | null {
  const o = scene.objects.get(id);
  if (!o || !scene.motionSpan(id) || scene.children(id).length) return null;
  const mesh = o.type === 'MESH' && o.data ? scene.doc.getMesh(o.data) : null;
  if (!mesh || mesh.positions.length < 3) return null;
  // the geometry within r of the origin of each object up the chain in turn
  let r = 0;
  const p = mesh.positions;
  for (let i = 0; i + 2 < p.length; i += 3) r = Math.max(r, Math.hypot(p[i], p[i + 1], p[i + 2]));
  const seen = new Set<string>();
  for (let cur: ObjectData | undefined = o; cur && !seen.has(cur.id);) {
    seen.add(cur.id);
    const t = channelRanges(scene, cur);
    if (!t) return null;
    const parent: ObjectData | undefined = cur.parent ? scene.objects.get(cur.parent) : undefined;
    if (!parent) {
      const g = t.scale * r;
      return {
        min: [t.location[0][0] - g, t.location[1][0] - g],
        max: [t.location[0][1] + g, t.location[1][1] + g],
      };
    }
    r = Math.hypot(...t.location.map(([a, b]) => Math.max(Math.abs(a), Math.abs(b)))) + t.scale * r;
    cur = parent;
  }
  return null;
}

/**
 * The values object `o`'s location takes, per axis, and the largest its scale takes, from its unmuted
 * F-curves (else its stored values); null when one is not finite.
 */
function channelRanges(
  scene: DeskScene,
  o: ObjectData,
): { location: [number, number][]; scale: number } | null {
  const curves = scene.objectCurves(o.id);
  if (!curves) return null;
  const range = (path: 'location' | 'scale', i: number): [number, number] => {
    const keys = curves.find((c) => c.fc.path === path && c.fc.index === i)?.keys;
    if (!keys) return [o[path][i], o[path][i]];
    let lo = Infinity;
    let hi = -Infinity;
    for (const k of keys) {
      lo = Math.min(lo, k.value);
      hi = Math.max(hi, k.value);
    }
    const pad = keys.some((k) => k.interpolation === 'BEZIER') ? (hi - lo) / 3 : 0;
    return [lo - pad, hi + pad];
  };
  const location = [0, 1, 2].map((i) => range('location', i));
  const scale = Math.max(...[0, 1, 2].map((i) => Math.max(...range('scale', i).map(Math.abs))));
  return [...location.flat(), scale].every(Number.isFinite) ? { location, scale } : null;
}

/**
 * body_in_water: the physics bodies in water in a shot's frame without floating: the middle of their
 * geometry over a water piece, their bottom touching its surface (WATER_TOUCH_M) or under it (but
 * not more than WATER_UNDER_M wholly under it: a basin raised above them), at frames the shot shows
 * that middle, unless desk.physics_bake let them float from there (desk_floats). A keyed body is
 * read on every frame (cheap: its keys alone place it), so that a bounce off the water between two
 * samples is seen; a body the simulation moves on the shot's samples. Its bounds are measured only
 * at frames its origin and reach do not rule water out (mayBeInWater). (The caller leaves out the
 * bodies whose keys keep them away from all water: mayReachWater.)
 */
function bodiesInWater(
  scene: DeskScene,
  s: ShotData,
  cam: string,
  samples: readonly number[],
  bodies: readonly WaterBody[],
): DeskIssue[] {
  const out: DeskIssue[] = [];
  let every: number[] | null = null;
  for (const b of bodies) {
    // where it is in water, read once per frame its keys move it (before and after them it stands still)
    const span = scene.motionSpan(b.id);
    const frames = span
      ? (every ??= Array.from({ length: s.frame_end - s.frame_start + 1 }, (_, i) => s.frame_start + i))
      : samples;
    const states = new Map<number, { c: Vec3; hit: WaterHit } | null>();
    const state = (f: number) => {
      const g = !span ? f : span[0] > span[1] ? s.frame_start : Math.min(span[1], Math.max(span[0], f));
      let st = states.get(g);
      if (st === undefined) {
        st = null;
        if (mayBeInWater(scene, b, g) && !scene.hidden(b.id, g)) {
          const box = scene.bounds(b.id, g);
          const c = boxCenter(box);
          const hit = waterAt(scene, [c[0], c[1], box.min[2]], g);
          if (
            hit &&
            box.min[2] <= hit.surface_z + WATER_TOUCH_M &&
            box.max[2] >= hit.surface_z - WATER_UNDER_M
          )
            st = { c, hit };
        }
        states.set(g, st);
      }
      return st;
    };
    const at = (f: number): WaterHit | null => {
      if (b.floats !== null && f >= b.floats) return null;
      const st = state(f);
      const view = st && scene.camera(cam, f);
      return st && view && inPicture(projectPoint(view, st.c)) ? st.hit : null;
    };
    const runs = waterRuns(frames, at);
    if (!runs.length) continue;
    const named = modelRootOf(scene.doc, b.id)?.id ?? b.id;
    for (const group of byPiece(runs)) {
      const water = group[0].hit;
      out.push(
        issue(
          'body_in_water',
          s.id,
          [named, water.owner],
          `${scene.name(named)} is in the water of ${water.label} in shot ${shotLabel(s)} (${runsWord(group)}) and ` +
            'does not float: re-aim desk.physics_throw (or the push or drop) so that it comes down on dry ground, ' +
            `or ${b.baked ? 'release it again and ' : ''}bake it with desk.physics_bake {water: 'float'} so that ` +
            'it floats',
        ),
      );
    }
  }
  return out;
}

/** The camera below the set's ground (inside its footprint), as a camera_inside hit. */
function belowGround(scene: DeskScene, p: Readonly<Vec3>): { owner: string; label: string } | null {
  for (const o of scene.objects.values()) {
    if (deskProp(o, DESK_PROPS.role) !== 'set' || deskProp(o, DESK_PROPS.label) !== 'ground') continue;
    const b = scene.bounds(o.id, scene.doc.getScene().frame_start);
    if (
      p[0] >= b.min[0] &&
      p[0] <= b.max[0] &&
      p[1] >= b.min[1] &&
      p[1] <= b.max[1] &&
      p[2] < b.max[2] - 1e-3
    )
      return { owner: o.id, label: 'the ground' };
  }
  return null;
}

/**
 * A jump cut between consecutive shots: a cut (not a continuous shot) between the same subjects, the
 * camera direction to them turned less than JUMP_CUT_DEG and their screen size within
 * JUMP_CUT_SIZE_RATIO. Returns the turn in degrees, or null.
 */
function jumpCut(scene: DeskScene, prev: ShotData, s: ShotData): number | null {
  if (s.continuity === 'continuous' || !prev.camera || !s.camera || !s.subjects.length) return null;
  const same =
    prev.subjects.length === s.subjects.length && s.subjects.every((id) => prev.subjects.includes(id));
  if (!same) return null;
  const va = scene.camera(prev.camera, prev.frame_end);
  const vb = scene.camera(s.camera, s.frame_start);
  const ca = centroid(scene, prev.subjects, prev.frame_end);
  const cb = centroid(scene, s.subjects, s.frame_start);
  if (!va || !vb || !ca || !cb) return null;
  const turn = angleBetween(v3sub(va.position, ca), v3sub(vb.position, cb));
  if (turn >= JUMP_CUT_DEG) return null;
  const sa = screenSize(scene, va, prev.subjects, prev.frame_end);
  const sb = screenSize(scene, vb, s.subjects, s.frame_start);
  if (!(sa > 0 && sb > 0) || Math.min(sa, sb) / Math.max(sa, sb) < JUMP_CUT_SIZE_RATIO) return null;
  return turn;
}

/** Active rigid bodies the scene simulates live (not baked to keys). */
function unbakedBodies(doc: SceneDoc, scene: DeskScene): string[] {
  if (!sanitizeRigidBodyWorld(doc.getScene().rigidbody_world).enabled) return [];
  const out: string[] = [];
  for (const o of scene.objects.values()) {
    const rb = sanitizeRigidBody(o.rigid_body);
    if (rb && rb.enabled && rb.type === 'ACTIVE' && !rb.kinematic) out.push(o.id);
  }
  return out;
}

function summarize(shots: number, issues: readonly DeskIssue[]): string {
  const count = (sev: DeskIssueSeverity) => issues.filter((i) => i.severity === sev).length;
  const e = count('error');
  const w = count('warning');
  const n = count('info');
  if (!issues.length) return `${shots} shot${shots === 1 ? '' : 's'} checked: no issues`;
  const codes = [...new Set(issues.map((i) => i.code))].join(', ');
  return `${shots} shot${shots === 1 ? '' : 's'} checked: ${e} error${e === 1 ? '' : 's'}, ${w} warning${w === 1 ? '' : 's'}, ${n} info (${codes})`;
}

/** The floor points of the main pair in a shot (for callers that draw the line). */
export function shotLinePoints(doc: SceneDoc, shot: ShotData): { a: Vec3; b: Vec3 } | null {
  const scene = new DeskScene(doc);
  const line = lineOfAction(scene);
  return line ? pairPoints(scene, [line.a, line.b], shot.frame_start) : null;
}
