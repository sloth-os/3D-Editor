import type { Vec3 } from '../../math/types';
import type { SceneDoc } from '../../doc/scene-doc';
import { FrameState } from '../../eval/frame-state';
import { DESK_PROPS } from '../props';
import {
  ANIMAL_GAITS,
  HUMAN_GAITS,
  LEG_COUNT,
  gaitDef,
  gaitStride,
  legRigs,
  moveTiming,
  turnRounds,
  type GaitName,
} from './gait';
import { BUILT_KINDS, isHumanoidKind } from './kinds';
import { TURN_STEP_KEYS, bodyFrameStride, splitAtSharpCorners } from './locomotion';
import type { ActorKind } from './types';

/*
 * What desk.actor_move and desk.actor_face key at most, for their memory estimates
 * (operators/memory-desk.ts), worked out before they run from the timing the move itself uses
 * (gait.ts moveTiming) without planning a footstep: every gait cycle keys the legs and the body that
 * carries them on its grid and half way between; a turn on the spot keys each of its steps
 * (TURN_STEP_KEYS); the speed ramps, the start and the end add a few keys per channel; a path with
 * sharp corners is walked as a move per part (locomotion.ts splitAtSharpCorners).
 */

/**
 * Channels a gait keys besides the end pose: the armature object's location and heading, the hips,
 * three per leg bone, and the sway of the body, the arms, the head and the tail (34 for people, 33
 * for a galloping quadruped).
 */
export const MOVE_GAIT_CHANNELS = 40;

/** Keys per channel of a move (of each part of it) besides its gait cycles and its turn on the spot: the start, the speed ramps and the end. */
export const MOVE_EXTRA_KEYS = 20;

/**
 * Keys per channel of a turn on the spot of up to half a turn (turnRounds): 8 through it, and each
 * step of each round keyed TURN_STEP_KEYS times.
 */
export function turnKeyBound(family: 'humanoid' | 'quadruped'): number {
  return 8 + LEG_COUNT[family] * turnRounds(family, Math.PI) * TURN_STEP_KEYS.length;
}

/**
 * The actor object `id` names: itself when it is an actor (an ARMATURE with desk_role 'actor'), the
 * actor a part belongs to (its desk_actor), else `id` (the operators name an actor by a part too).
 */
export function actorOf(doc: SceneDoc, id: string | null): string | null {
  if (!id) return null;
  const isActor = (x: string): boolean => {
    const o = doc.getObject(x);
    return !!o && o.type === 'ARMATURE' && o.custom_props?.[DESK_PROPS.role] === 'actor';
  };
  if (isActor(id)) return id;
  const owner = doc.getObject(id)?.custom_props?.[DESK_PROPS.actor];
  return typeof owner === 'string' && isActor(owner) ? owner : id;
}

/** The family of a built actor `actorId` and its size (m), or null. */
function builtActor(
  doc: SceneDoc,
  actorId: string,
): { family: 'humanoid' | 'quadruped'; size: number; location: Vec3 } | null {
  const o = doc.getObject(actorId);
  const props = o?.custom_props ?? {};
  const kind = String(props[DESK_PROPS.kind] ?? '');
  if (!o || o.type !== 'ARMATURE' || props[DESK_PROPS.role] !== 'actor') return null;
  if (!BUILT_KINDS.includes(kind as ActorKind)) return null;
  const h = Number(props[DESK_PROPS.heightM]);
  return {
    family: isHumanoidKind(kind) ? 'humanoid' : 'quadruped',
    size: Number.isFinite(h) && h > 0 ? h : 1.7,
    location: [...o.location],
  };
}

/**
 * Keys desk.actor_face writes at most on actor `actorId`: an actor standing on its feet steps round
 * (every channel of the gait keyed through a turn on the spot, turnKeyBound); one that does not
 * turns whole (its heading keyed before and after). Never throws.
 */
export function faceKeyBound(doc: SceneDoc, actorId: string | null): number {
  try {
    const a = actorId ? builtActor(doc, actorId) : null;
    return a ? (turnKeyBound(a.family) + 2) * MOVE_GAIT_CHANNELS : 12;
  } catch {
    return 12;
  }
}

/** The keys a move writes at most: on its busiest channel, and on all channels of the gait. */
export interface MoveKeyBound {
  perChannel: number;
  keys: number;
  /** Seconds from the first step to the arrival (the turn on the spot not included). */
  seconds: number;
}

const finite3 = (q: unknown): q is Vec3 =>
  Array.isArray(q) && q.length === 3 && q.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * The keys desk.actor_move writes at most for actor `actorId` moving through `p.points` (its
 * parameters: frame_start, frame_end, speed_mps, gait), or null when `actorId` is not a built actor
 * (the move then fails before keying anything). Never throws.
 */
export function moveKeyBound(
  doc: SceneDoc,
  actorId: string,
  p: {
    points?: unknown;
    frame_start?: unknown;
    frame_end?: unknown;
    speed_mps?: unknown;
    gait?: unknown;
    face_path?: unknown;
  },
): MoveKeyBound | null {
  try {
    const a = builtActor(doc, actorId);
    if (!a) return null;
    const { family, size } = a;
    const f0 = typeof p.frame_start === 'number' && Number.isFinite(p.frame_start) ? p.frame_start : 1;
    // the path from where the actor stands at frame_start
    const w = new FrameState(doc, f0).world(actorId);
    const path: Vec3[] = [w ? [w[12], w[13], w[14]] : a.location];
    // without face_path the steps are laid out in the body's frame, shorter backwards and sideways
    // (locomotion.ts bodyFrameStride; the narrowest stance a gait of the family takes)
    let strideK = (_S: number) => 1;
    if (p.face_path === false) {
      const arm = doc.getArmature(doc.getObject(actorId)?.data ?? '');
      const legs = arm ? legRigs(arm, family) : [];
      const narrow = family === 'humanoid' ? 0.6 : 1;
      const restLat = legs.length ? Math.min(...legs.map((l) => Math.abs(l.root[0]) * narrow)) : 0;
      const fl = w ? Math.hypot(w[4], w[5]) || 1 : 1;
      const fwd: Vec3 = w ? [-w[4] / fl, -w[5] / fl, 0] : [0, -1, 0];
      strideK = (S: number) => bodyFrameStride(path, fwd, S, size, restLat).k;
    }
    let L = 0;
    for (const q of Array.isArray(p.points) ? p.points : []) {
      if (!finite3(q)) continue;
      const prev = path[path.length - 1];
      L += Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]);
      path.push(q);
    }
    if (L < 1e-3) return { perChannel: 2, keys: 2 * MOVE_GAIT_CHANNELS, seconds: 0 };
    // each part of a path cut at its sharp corners starts and stops, and turns on the spot first
    const parts = splitAtSharpCorners(path).length;
    const extra = parts * (MOVE_EXTRA_KEYS + turnKeyBound(family));
    const fps = Math.max(1, doc.getScene().fps || 24);
    const total =
      typeof p.frame_end === 'number' && Number.isFinite(p.frame_end) && p.frame_end > f0
        ? (p.frame_end - f0) / fps
        : null;
    const speed = typeof p.speed_mps === 'number' && p.speed_mps > 0 ? p.speed_mps : undefined;
    const asked =
      typeof p.gait === 'string' && p.gait !== 'auto' && gaitDef(family, p.gait as GaitName)
        ? (p.gait as GaitName)
        : null;
    // with and without a turn on the spot first (it shortens the walk when frame_end is given)
    let perChannel = 0;
    let seconds = 0;
    for (const dTurn of [0, Math.PI]) {
      const t = moveTiming(family, size, L, dTurn, { asked, speed, total });
      const S = t.S * strideK(t.S);
      // a key on each step of the grid and a half key between each two
      const perCycle = 2 * t.g.grid;
      perChannel = Math.max(perChannel, Math.ceil((L / S + 2 * parts) * perCycle) + extra);
      seconds = Math.max(seconds, (L / t.v) * (t.S / S) + t.ta);
    }
    if (parts > 1 && total !== null) {
      // parts timed to arrive together walk faster than the whole path would (they turn and stop on
      // the way), each at least L / total: the shortest stride of any gait the speed may pick
      const gaits: GaitName[] = asked
        ? [asked]
        : (Object.keys(family === 'humanoid' ? HUMAN_GAITS : ANIMAL_GAITS) as GaitName[]);
      for (const name of gaits) {
        const g = gaitDef(family, name)!;
        const S0 = gaitStride(g, family, size, L / total);
        const S = S0 * strideK(S0);
        perChannel = Math.max(perChannel, Math.ceil((L / S + 2 * parts) * 2 * g.grid) + extra);
      }
    }
    return { perChannel, keys: perChannel * MOVE_GAIT_CHANNELS, seconds };
  } catch {
    return null;
  }
}

/**
 * Keys desk.actor_look_at writes at most on actor `actorId`: the influence of its look on the neck
 * and the head ramped (two keys each), and every other look there ramped out.
 */
export function lookKeyBound(doc: SceneDoc, actorId: string | null): number {
  const bones = (actorId ? doc.getObject(actorId)?.pose?.bones : null) ?? {};
  let looks = 0;
  for (const bone of ['neck', 'head'])
    for (const c of bones[bone]?.constraints ?? []) if (c.type === 'DAMPED_TRACK') looks++;
  return 4 + 2 * looks;
}

/**
 * Objects whose release or dismount keys follow `actorId`'s bones (a CHILD_OF on the actor: the props
 * it holds, its riders): every move, turn, pose, look, hold and ride of the actor keys them again.
 */
export function attachedTo(doc: SceneDoc, actorId: string | null): string[] {
  if (!actorId) return [];
  const out: string[] = [];
  for (const [id, y] of doc.map('objects').entries()) {
    if (id === actorId) continue;
    const list = (y as { get(key: string): unknown }).get('constraints');
    if (!Array.isArray(list)) continue;
    if (
      list.some(
        (c) => !!c && (c as ConstraintLike).type === 'CHILD_OF' && (c as ConstraintLike).target === actorId,
      )
    )
      out.push(id);
  }
  return out;
}

interface ConstraintLike {
  type?: unknown;
  target?: unknown;
}
