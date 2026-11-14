import type { Vec3 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import type { ShotData } from '../doc/types';
import { sanitizeRigidBody, sanitizeRigidBodyWorld } from '../physics/settings';
import { findShotIndex, getDeskSettings, getShots, shotOutputFrames } from './shots';
import { DESK_PROPS } from './props';
import { DeskScene, deskProp, inPicture, projectPoint, v3sub, type CameraView } from './layout';
import { crossesLine, lineOfAction, pairPoints } from './line';
import { inFrameSamples, shotSamples, shotSpec, unframedSubjects } from './solver';
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
 * duration_clamped, physics_unbaked and shot_gap. The blocking line and the moves sentence are
 * rideo's, word for word, with the scene's object names.
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
  plan_mismatch: 'warning',
  screen_direction: 'warning',
  jump_cut: 'warning',
  absent_in_frame: 'warning',
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
    if (!s) continue;
    const top = projectPoint(view, s.head);
    const bottom = projectPoint(view, s.feet);
    if (Number.isFinite(top.y) && Number.isFinite(bottom.y))
      size = Math.max(size, Math.abs(top.y - bottom.y) / 2);
  }
  return size;
}

/** The centre of the subjects' feet at `frame` (null when none is there). */
function centroid(scene: DeskScene, subjects: readonly string[], frame: number): Vec3 | null {
  const pts = subjects.map((id) => scene.subject(id, frame)?.feet).filter((p): p is Vec3 => !!p);
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
  if (!view || !a || !b || shot.frame_end === shot.frame_start) return 0;
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
        if (sub && (Math.abs(sub.feet[0]) > halfW || Math.abs(sub.feet[1]) > halfD))
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
        // a rider above its mount does not stand in its place
        if (
          a &&
          b &&
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
    const unframed = unframedSubjects(scene, s.subjects, shotSpec(scene, s, all.indexOf(s)));
    const frames = inFrameSamples(s);
    for (const id of s.subjects) {
      if (unframed.has(id)) continue;
      const out: number[] = [];
      for (const f of frames) {
        const v = scene.camera(cam, f);
        const sub = scene.subject(id, f);
        if (!v || !sub) continue;
        const p = projectPoint(v, sub.actor ? sub.eyes : sub.center);
        if (!(Number.isFinite(p.x) && Math.abs(p.x) <= 1 && p.y >= -1 && p.y <= 1.15)) out.push(f);
      }
      if (out.length)
        issues.push(
          issue(
            'subject_out_of_frame',
            s.id,
            [id],
            `${name(id)} is not in the frame of shot ${shotLabel(s)} (frame${out.length > 1 ? 's' : ''} ${out.join(', ')})`,
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
        if (sub && inPicture(projectPoint(view, sub.chest), 0.9))
          issues.push(
            issue(
              'absent_in_frame',
              s.id,
              [id],
              `${name(id)} is not in shot ${shotLabel(s)} but stands in its frame`,
            ),
          );
      }
  }

  // between consecutive shots of the cut
  for (let i = 1; i < cut.length; i++) {
    const prev = cut[i - 1];
    const s = cut[i];
    if (!isChecked.has(s.id)) continue;
    if (s.continuity !== 'continuous')
      for (const id of s.subjects.filter((c) => prev.subjects.includes(c) && scene.isActor(c))) {
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
