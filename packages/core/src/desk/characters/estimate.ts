import type { Vec3 } from '../../math/types';
import type { SceneDoc } from '../../doc/scene-doc';
import { FrameState } from '../../eval/frame-state';
import { DESK_PROPS } from '../props';
import { gaitDef, moveTiming, type GaitName } from './gait';
import { BUILT_KINDS, isHumanoidKind } from './kinds';
import type { ActorKind } from './types';

/*
 * What desk.actor_move keys at most, for its memory estimate (operators/memory-desk.ts), worked out
 * before the move runs from the timing the move itself uses (gait.ts moveTiming) without planning a
 * footstep: every gait cycle keys the legs and the body that carries them on its grid and half way
 * between; the turn on the spot, the speed ramps, the start and the end add a few keys per channel.
 */

/**
 * Channels a gait keys besides the end pose: the armature object's location and heading, the hips,
 * three per leg bone, and the sway of the body, the arms, the head and the tail (34 for people, 33
 * for a galloping quadruped).
 */
export const MOVE_GAIT_CHANNELS = 40;

/** Keys per channel besides the gait cycles: the turn on the spot (8 and a step per leg), the start and the end. */
export const MOVE_EXTRA_KEYS = 32;

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
  p: { points?: unknown; frame_start?: unknown; frame_end?: unknown; speed_mps?: unknown; gait?: unknown },
): MoveKeyBound | null {
  try {
    const o = doc.getObject(actorId);
    const props = o?.custom_props ?? {};
    const kind = String(props[DESK_PROPS.kind] ?? '');
    if (!o || o.type !== 'ARMATURE' || props[DESK_PROPS.role] !== 'actor') return null;
    if (!BUILT_KINDS.includes(kind as ActorKind)) return null;
    const family = isHumanoidKind(kind) ? 'humanoid' : 'quadruped';
    const h = Number(props[DESK_PROPS.heightM]);
    const size = Number.isFinite(h) && h > 0 ? h : 1.7;
    const f0 = typeof p.frame_start === 'number' && Number.isFinite(p.frame_start) ? p.frame_start : 1;
    // the path from where the actor stands at frame_start
    const w = new FrameState(doc, f0).world(actorId);
    let prev: Vec3 = w ? [w[12], w[13], w[14]] : [...o.location];
    let L = 0;
    for (const q of Array.isArray(p.points) ? p.points : []) {
      if (!finite3(q)) continue;
      L += Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]);
      prev = q;
    }
    if (L < 1e-3) return { perChannel: 2, keys: 2 * MOVE_GAIT_CHANNELS, seconds: 0 };
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
      const { g, v, S, ta } = moveTiming(family, size, L, dTurn, { asked, speed, total });
      // a key on each step of the grid and a half key between each two
      const perCycle = 2 * g.grid;
      perChannel = Math.max(perChannel, Math.ceil((L / S + 2) * perCycle) + MOVE_EXTRA_KEYS);
      seconds = Math.max(seconds, L / v + ta);
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
