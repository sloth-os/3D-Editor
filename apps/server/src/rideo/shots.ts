import {
  DESK_PROPS,
  FrameState,
  cameraFovY,
  evaluateFCurve,
  fcurveKey,
  orthoHalfExtents,
  type Mat4,
  type ObjectData,
  type SceneDoc,
  type ShotData,
  type Vec3,
} from '@3d-editor/core';
import type { PassName } from '../render/protocol';

/*
 * Which shots of an export get a reference video in rideo, in which mode and from which pass
 * (SPEC §0(d), §11). A reference turns off multi-shot grouping for its shot in rideo, so by default
 * only the shots whose motion a video model gets wrong are pushed: physics (drops, throws, pushes,
 * baked or simulated), tethered flyers (kites, balloons), props an actor holds, and camera moves.
 * What a shot shows is read from the project at a few frames of the shot: an object counts when its
 * origin (an actor's middle) projects into the shot camera's frame, give or take 15 %.
 *
 * Modes: 'camera' when rideo's first frame cannot have been drawn from our staging (the desk is off
 * in rideo, the board was approved before, the shot starts from an image, or rideo's blocking line
 * differs from ours); otherwise 'motion' for shots with props in motion (physics, tethers, holds) and
 * 'pose' for shots of actors; a shot with neither (a camera move over a set) is 'camera'. Passes:
 * motion → beauty (in the export's look; previs renders clay), pose → pose, camera → depth.
 */

export const REFERENCE_MODES = ['motion', 'pose', 'camera'] as const;
export type ReferenceMode = (typeof REFERENCE_MODES)[number];

/** The pass each mode sends by default. */
export const DEFAULT_PASS: Readonly<Record<ReferenceMode, PassName>> = {
  motion: 'beauty',
  pose: 'pose',
  camera: 'depth',
};

/** What a shot shows that matters for its reference. */
export interface ShotFeatures {
  /** The camera moves (a move other than locked_off, or its position or aim changes over the shot). */
  camera_move: boolean;
  /** Rigid bodies (simulated, or baked to keys) move in view: drops, throws, pushes. */
  physics: boolean;
  /** A tethered flyer (kite, balloon) flies in view. */
  tether: boolean;
  /** An actor holds a prop in view. */
  held: boolean;
  /** Actors in view (or among the shot's subjects). */
  characters: boolean;
  /** What was found, e.g. "Kite (tether)", for the results. */
  found: string[];
}

/** Frames sampled per shot (first, last and evenly between). */
export const SHOT_SAMPLES = 5;
/** How far outside the frame an origin may project and still count as in view (1 = the frame's edge). */
const VIEW_MARGIN = 1.15;
/** Below this, the camera did not move (metres) or turn (cosine of the angle between aims). */
const MOVE_EPS_M = 0.01;
const TURN_COS = Math.cos((0.5 * Math.PI) / 180);
/**
 * An object scaled below this is shrunk away: a string before and after its flight (tether.ts
 * TETHER_HIDDEN_SCALE), an actor or prop the rideo import hides in the shots without it.
 */
const HIDDEN_SCALE = 1e-4;
/** Custom properties of other modules this module reads. */
const STRING_TO = 'desk_string_to';
const BAKED = 'rigid_body_baked';

/** The scene frames sampled in [start, end] (whole frames, ascending, without repeats). */
export function sampleFrames(start: number, end: number, n = SHOT_SAMPLES): number[] {
  if (!(end > start) || n < 2) return [Math.round(start)];
  const out = new Set<number>();
  for (let i = 0; i < n; i++) out.add(Math.round(start + ((end - start) * i) / (n - 1)));
  return [...out].sort((a, b) => a - b);
}

interface View {
  pos: Vec3;
  fwd: Vec3;
  right: Vec3;
  up: Vec3;
  ortho: boolean;
  /** tan of half the field of view (perspective) or half extents (orthographic). */
  sx: number;
  sy: number;
}

const sub = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function unit(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
const translation = (m: Mat4): Vec3 => [m[12], m[13], m[14]];
/** Length of a column of a column-major matrix (the object's scale along that local axis). */
const columnLength = (m: Mat4, c: number) => Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]);

function cameraView(doc: SceneDoc, fs: FrameState, cameraId: string, aspect: number): View | null {
  const o = doc.getObject(cameraId);
  if (!o || o.type !== 'CAMERA' || !o.data) return null;
  const cam = doc.getCamera(o.data);
  const m = fs.world(cameraId);
  if (!cam || !m) return null;
  const view = {
    pos: translation(m),
    right: unit([m[0], m[1], m[2]]),
    up: unit([m[4], m[5], m[6]]),
    // cameras look along their local −Z
    fwd: unit([-m[8], -m[9], -m[10]]),
  };
  if (cam.type === 'ORTHO') {
    const { halfW, halfH } = orthoHalfExtents(cam, aspect);
    return { ...view, ortho: true, sx: halfW, sy: halfH };
  }
  const tanV = Math.tan(cameraFovY(cam, aspect) / 2);
  return { ...view, ortho: false, sx: tanV * aspect, sy: tanV };
}

/** Whether a point projects into the view's frame (with the margin), in front of the camera. */
export function inView(v: View, p: Readonly<Vec3>, margin = VIEW_MARGIN): boolean {
  const d = sub(p, v.pos);
  const depth = dot(d, v.fwd);
  if (!v.ortho && depth <= 0.05) return false;
  const k = v.ortho ? 1 : depth;
  return Math.abs(dot(d, v.right) / (k * v.sx)) <= margin && Math.abs(dot(d, v.up) / (k * v.sy)) <= margin;
}

const role = (o: ObjectData | null | undefined): string => {
  const r = o?.custom_props?.[DESK_PROPS.role];
  return typeof r === 'string' ? r : '';
};

/** The frames 'frames A-B step S' of a baked rigid body (desk/physics bake), or null. */
function bakedRange(o: ObjectData): [number, number] | null {
  const v = o.custom_props?.[BAKED];
  const m = typeof v === 'string' ? /frames\s+(-?\d+)\s*-\s*(-?\d+)/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** The influence of an object constraint at a frame (its keyed channel, else its stored value). */
function influenceAt(doc: SceneDoc, objectId: string, name: string, stored: number, frame: number): number {
  const fc = doc.getFCurve(
    fcurveKey({
      target_type: 'object',
      target_id: objectId,
      path: `constraints[${JSON.stringify(name)}].influence`,
      index: 0,
    }),
  );
  const v = fc && !fc.mute ? evaluateFCurve(fc, frame) : undefined;
  return v ?? stored;
}

/**
 * What a shot shows over its frames (see the module comment). `aspect` is the export's width/height
 * (it decides the camera's field of view).
 */
export function shotFeatures(doc: SceneDoc, shot: ShotData, aspect: number): ShotFeatures {
  const out: ShotFeatures = {
    camera_move: !!shot.move && shot.move !== 'locked_off',
    physics: false,
    tether: false,
    held: false,
    characters: false,
    found: [],
  };
  const scene = doc.getScene();
  const cameraId = shot.camera ?? scene.camera ?? null;
  const frames = sampleFrames(shot.frame_start, shot.frame_end);
  const objects = doc.listObjects();
  const byId = new Map(objects.map((o) => [o.id, o]));
  const actors = objects.filter((o) => role(o) === 'actor');
  const subjects = new Set(shot.subjects);
  if (shot.subjects.some((id) => role(byId.get(id)) === 'actor')) out.characters = true;

  const world = scene.rigidbody_world;
  const simulated = objects.filter(
    (o) => o.rigid_body && o.rigid_body.enabled !== false && o.rigid_body.type === 'ACTIVE',
  );
  const simulating =
    !!world?.enabled && world.frame_start <= shot.frame_end && world.frame_end >= shot.frame_start;
  const baked = objects
    .map((o) => ({ o, range: bakedRange(o) }))
    .filter(
      (b): b is { o: ObjectData; range: [number, number] } =>
        !!b.range && b.range[0] <= shot.frame_end && b.range[1] >= shot.frame_start,
    );
  const strings = objects.filter((o) => role(o) === 'string');
  const holds = objects.flatMap((o) =>
    role(o) === 'actor'
      ? []
      : (o.constraints ?? [])
          .filter((c) => c.type === 'CHILD_OF' && !c.mute && c.target && role(byId.get(c.target)) === 'actor')
          .map((c) => ({ o, c })),
  );

  const note = (what: string) => {
    if (!out.found.includes(what)) out.found.push(what);
  };
  let base: FrameState | null = null;
  let firstPos: Vec3 | null = null;
  let firstFwd: Vec3 | null = null;
  const bakedFirst = new Map<string, Vec3>();
  for (const frame of frames) {
    const fs: FrameState = base
      ? new FrameState(doc, frame, null, { base })
      : new FrameState(doc, frame, null);
    base ??= fs;
    const view = cameraId ? cameraView(doc, fs, cameraId, aspect) : null;
    if (view) {
      if (!firstPos || !firstFwd) {
        firstPos = view.pos;
        firstFwd = view.fwd;
      } else if (Math.hypot(...sub(view.pos, firstPos)) > MOVE_EPS_M || dot(view.fwd, firstFwd) < TURN_COS)
        out.camera_move = true;
    }
    const shrunk = (m: Mat4) =>
      Math.max(columnLength(m, 0), columnLength(m, 1), columnLength(m, 2)) < HIDDEN_SCALE;
    const seen = (id: string, lift = 0): boolean => {
      const m = fs.world(id);
      if (!m || !view || shrunk(m)) return false;
      const p = translation(m);
      return inView(view, p) || (lift > 0 && inView(view, [p[0], p[1], p[2] + lift]));
    };
    for (const a of actors) {
      if (out.characters && subjects.has(a.id)) break;
      const h = Number(a.custom_props?.[DESK_PROPS.heightM]) || 1.7;
      if (seen(a.id, h / 2)) {
        out.characters = true;
        break;
      }
    }
    // simulated bodies: their stored (or keyed) place before the simulation moves them
    if (simulating)
      for (const o of simulated) {
        const start = o.rigid_body?.start_frame ?? world.frame_start;
        if (start <= shot.frame_end && seen(o.id)) {
          out.physics = true;
          note(`${o.name} (physics)`);
        }
      }
    // baked bodies: they count when their keys move them during the shot, in view
    for (const { o, range } of baked) {
      if (frame < range[0] || frame > range[1]) continue;
      const m = fs.world(o.id);
      if (!m) continue;
      const p = translation(m);
      const first = bakedFirst.get(o.id);
      if (!first) bakedFirst.set(o.id, p);
      else if (Math.hypot(...sub(p, first)) > MOVE_EPS_M && (seen(o.id) || (view && inView(view, first)))) {
        out.physics = true;
        note(`${o.name} (physics)`);
      }
    }
    for (const s of strings) {
      const m = fs.world(s.id);
      if (!m || shrunk(m)) continue;
      const flyer = s.custom_props?.[STRING_TO];
      const flyerId = typeof flyer === 'string' ? flyer : null;
      if (seen(s.id) || (flyerId && seen(flyerId))) {
        out.tether = true;
        note(`${(flyerId && byId.get(flyerId)?.name) || s.name} (tether)`);
      }
    }
    for (const { o, c } of holds) {
      if (influenceAt(doc, o.id, c.name, c.influence, frame) <= 0.5) continue;
      if (seen(o.id) || (c.target && seen(c.target, 0.85))) {
        out.held = true;
        note(`${o.name} (held)`);
      }
    }
  }
  return out;
}

/** Whether a shot gets a reference by default: props in motion or a camera move. */
export function needsReference(f: ShotFeatures): boolean {
  return f.physics || f.tether || f.held || f.camera_move;
}

/**
 * The default mode of a shot: 'camera' when rideo's first frame cannot follow our staging, else
 * 'motion' for props in motion, 'pose' for actors, 'camera' for the rest.
 */
export function defaultMode(f: ShotFeatures, firstFrameMatches: boolean): ReferenceMode {
  if (!firstFrameMatches) return 'camera';
  if (f.physics || f.tether || f.held) return 'motion';
  return f.characters ? 'pose' : 'camera';
}
