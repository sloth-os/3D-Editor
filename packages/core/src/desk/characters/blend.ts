import type { Vec3 } from '../../math/types';
import type { ArmatureData, FCurve, Keyframe, PoseBone } from '../../doc/types';
import type { SceneDoc } from '../../doc/scene-doc';
import { createFCurve, evaluateFCurve } from '../../anim/fcurve';
import { DEG, SIDES, partSurfaces, type Blueprint, type PartSurface } from './rig';
import { lowestOf, posedArmature, reposeChain, type PosedArmature } from './poses';
import { bonePath, type KeyWriter } from './keys';

/*
 * Hands kept out of the ground while a pose blends in (writePoseKeys `ground`). Joint angles blend
 * per Euler component, so an arm swinging from behind a seat on the ground to the front (sit_ground
 * to reach, and back again) passes straight down from a shoulder half a metre up: through the
 * ground. A pose keyed over low legs that stay where they are (a gesture layered over a stance, the
 * stance keyed again after it) looks at the keys it is about to write at the frames of its blend; an
 * arm that would take its hand into the ground gets one more key, in the middle of the blend: the
 * elbow bent (and, where bending is not enough, the arm raised sideways) just enough that the hand
 * stays out of the ground at every frame. One key in the middle keeps the lift a smooth swell over
 * the whole blend (the hand lifts off and comes round, as people do), not a jerk at the worst frame.
 */

/** How far below the ground (share of the height) a blend may take a hand before the arm is lifted. */
export const BLEND_SINK = 0.01;
/** A lifted arm keeps its hand at least this close to the ground at the frames it sank at (share of the height). */
const LIFTED_SINK = 0.004;
/** Frames of a blend looked at, at most (a longer blend is sampled evenly). */
const MAX_SAMPLES = 24;
/** How far an elbow bends at most, how far an arm is raised sideways at most, and the search steps (degrees). */
const MAX_ELBOW = 150;
const MAX_RAISE = 60;
const STEP = 10;

/** Each arm: its side, the sign of a sideways raise about the upper arm's local Z (poses.ts), its bones. */
const ARMS = SIDES.map((side) => ({
  side,
  out: side === 'L' ? -1 : 1,
  bones: [`shoulder.${side}`, `upper_arm.${side}`, `forearm.${side}`, `hand.${side}`],
}));

/** What a blend is keyed over (writePoseKeys `ground`). */
export interface BlendGround {
  arm: ArmatureData;
  bp: Blueprint;
  /** The actor's bones at the pose's frame, for the channels the keys leave (a layer's legs). */
  base: Record<string, PoseBone>;
  /** Its bones where the blend starts. */
  start: Record<string, PoseBone>;
}

/** A channel component the keys write. */
export interface KeyedChannel {
  bone: string;
  channel: 'rotation_euler' | 'location';
  index: number;
}

type Group = { probes: Blueprint['probes']; surface: readonly PartSurface[] };
type Override = { c: KeyedChannel; fc: FCurve };

const rot = (b: PoseBone | undefined): Vec3 => (b?.rotation_euler as Vec3 | undefined) ?? [0, 0, 0];
const keyOf = (bone: string, channel: string, i: number) => `${bone}|${channel}|${i}`;

/**
 * Adds keys to `w` (before it is committed) where the blend from `from` to `frame` would take a
 * hand into the ground: lower than the body is at either end of the blend (and than z = 0) by more
 * than BLEND_SINK of its height, while the rest of the body stays up (a change that takes the whole
 * body through the ground is not an arm's doing; nothing is keyed then). Only the arms the keys
 * move are lifted, and only by a lift that keeps the hand within BLEND_SINK of the ground at every
 * frame. `written`: the channel components `w` keys; `end`: the end of the pose's hold. Returns the
 * number of arms lifted.
 */
export function liftArms(
  doc: SceneDoc,
  id: string,
  w: KeyWriter,
  written: readonly KeyedChannel[],
  g: BlendGround,
  f: { from: number; frame: number; end: number },
): number {
  const mid = Math.round((f.from + f.frame) / 2);
  if (!(mid > f.from && mid < f.frame)) return 0;
  const arms = ARMS.map((a) => written.some((c) => a.bones.includes(c.bone)));
  if (!arms.some(Boolean)) return 0;
  const surface = partSurfaces(g.bp);
  const group = (keep: (bone: string) => boolean): Group => ({
    probes: g.bp.probes.filter((p) => keep(p.bone)),
    surface: surface.filter((s) => keep(s.bone)),
  });
  const armBones = new Set(ARMS.flatMap((a) => a.bones));
  const rest = group((b) => !armBones.has(b));
  const armGroups = ARMS.map((a) => group((b) => a.bones.includes(b)));
  const keyed = new Map(written.map((c) => [keyOf(c.bone, c.channel, c.index), c]));
  const curves = new Map<string, FCurve | null>();
  const curveOf = (c: KeyedChannel) => {
    const k = keyOf(c.bone, c.channel, c.index);
    if (!curves.has(k)) curves.set(k, w.curve(doc, id, bonePath(c.bone, c.channel), c.index));
    return curves.get(k) ?? null;
  };
  const setFrom = (bones: Record<string, PoseBone>, c: KeyedChannel, fc: FCurve | null, t: number) => {
    const pb = bones[c.bone];
    if (!pb || !fc) return;
    const v = [...pb[c.channel]] as Vec3;
    v[c.index] = evaluateFCurve(fc, t) ?? v[c.index];
    bones[c.bone] = { ...pb, [c.channel]: v };
  };
  // the actor's bones at frame t of the blend, the keyed channels as the keys will have them
  const samples = new Map<number, Record<string, PoseBone>>();
  const sample = (t: number) => {
    let bones = samples.get(t);
    if (!bones) {
      bones = { ...g.base };
      for (const c of keyed.values()) setFrom(bones, c, curveOf(c), t);
      samples.set(t, bones);
    }
    return bones;
  };
  // the same with a lift being tried
  const tried = (t: number, over: ReadonlyMap<string, Override>) => {
    const bones = { ...sample(t) };
    for (const { c, fc } of over.values()) setFrom(bones, c, fc, t);
    return bones;
  };
  // the actor posed at frame t (by the pose evaluator), and how low a group of its parts is then
  const posed = new Map<number, PosedArmature>();
  const posedAt = (t: number) => {
    let p = posed.get(t);
    if (!p) posed.set(t, (p = posedArmature(g.arm, sample(t))));
    return p;
  };
  const lowAt = (t: number, grp: Group) => lowestOf(posedAt(t).deltas, grp.probes, grp.surface);
  const span = f.frame - f.from;
  const step = Math.max(1, Math.ceil(span / MAX_SAMPLES));
  const frames: number[] = [];
  for (let t = f.from + step; t < f.frame - 1e-6; t += step) frames.push(t);
  const whole: Group = { probes: g.bp.probes, surface };
  const ground = Math.min(
    0,
    lowestOf(posedArmature(g.arm, g.start).deltas, whole.probes, whole.surface),
    lowAt(f.frame, whole),
  );
  const h = g.bp.height;
  const limit = ground - BLEND_SINK * h;
  // the frames each keyed arm goes into the ground at
  const sunk = ARMS.map(() => [] as number[]);
  for (const t of frames)
    for (let a = 0; a < ARMS.length; a++) if (arms[a] && lowAt(t, armGroups[a]) < limit) sunk[a].push(t);
  if (sunk.every((s) => !s.length)) return 0;
  // nothing to do when the rest of the body goes down there too: no arm can help that
  for (const t of new Set(sunk.flat())) if (lowAt(t, rest) < limit) return 0;
  // the curve of one rotation component with the blend's middle moved by `delta` (radians)
  const bumped = (bone: string, i: number, delta: number): Override => {
    const c: KeyedChannel = { bone, channel: 'rotation_euler', index: i };
    const own = keyed.has(keyOf(bone, 'rotation_euler', i)) ? curveOf(c) : null;
    let keys: Keyframe[];
    let fc: FCurve;
    if (own) {
      const v = evaluateFCurve(own, mid) ?? 0;
      keys = own.keyframes.filter((k) => Math.abs(k.frame - mid) > 1e-3);
      keys.push({ frame: mid, value: v + delta, interpolation: 'BEZIER' });
      fc = own;
    } else {
      // a channel the pose leaves where it is: it holds one value through the blend and the hold
      const v = rot(g.base[bone])[i];
      keys = [...new Set([f.from, f.frame, f.end])].map((frame) => ({
        frame,
        value: v,
        interpolation: 'BEZIER' as const,
      }));
      keys.push({ frame: mid, value: v + delta, interpolation: 'BEZIER' });
      fc = createFCurve({
        target_type: 'object',
        target_id: id,
        path: bonePath(bone, 'rotation_euler'),
        index: i,
      });
    }
    keys.sort((a, b) => a.frame - b.frame);
    return { c, fc: { ...fc, keyframes: keys, extrapolation: 'CONSTANT' } };
  };
  let lifted = 0;
  for (let a = 0; a < ARMS.length; a++) {
    if (!sunk[a].length) continue;
    const { side, out } = ARMS[a];
    const fore = `forearm.${side}`;
    const upper = `upper_arm.${side}`;
    const chain = [upper, fore, `hand.${side}`];
    if (!g.base[fore] || !g.base[upper]) continue;
    // an arm its constraints hold (a carrying posture) is not lifted: its keys do not move it
    if (chain.some((b) => g.base[b]?.constraints?.some((c) => !c.mute && (c.influence ?? 1) > 0))) continue;
    // the elbow's flexion in the middle of the blend (poses.ts: forearm X is minus the flexion)
    const bent = -rot(sample(mid)[fore])[0] / DEG;
    const lift = (bend: number, raise: number) => {
      const over = new Map<string, Override>();
      if (bend) over.set(keyOf(fore, 'rotation_euler', 0), bumped(fore, 0, -bend * DEG));
      if (raise) over.set(keyOf(upper, 'rotation_euler', 2), bumped(upper, 2, out * raise * DEG));
      return over;
    };
    // how low the arm goes at frames `at` with a lift: only its chain posed again (cheap), or
    // `exact`ly, the whole body posed by the evaluator
    const lowest = (over: ReadonlyMap<string, Override>, at: readonly number[], exact = false) =>
      Math.min(
        ...at.map((t) => {
          const bones = tried(t, over);
          const deltas = exact
            ? posedArmature(g.arm, bones).deltas
            : reposeChain(g.arm, posedAt(t), bones, chain);
          return lowestOf(deltas, armGroups[a].probes, armGroups[a].surface);
        }),
      );
    // the least lift that clears the frames the arm sank at without sinking it at another: the
    // elbow bent further (how people lift a hand off the ground), else the arm raised sideways,
    // else both
    const most = Math.floor((MAX_ELBOW - bent) / STEP) * STEP;
    const lifts: [number, number][] = [];
    for (let bend = STEP; bend <= most; bend += STEP) lifts.push([bend, 0]);
    for (let raise = STEP; raise <= MAX_RAISE; raise += STEP) lifts.push([0, raise]);
    if (most > 0) for (let raise = STEP; raise <= MAX_RAISE; raise += STEP) lifts.push([most, raise]);
    let chosen: Map<string, Override> | null = null;
    for (const [bend, raise] of lifts) {
      const over = lift(bend, raise);
      if (
        lowest(over, sunk[a]) >= ground - LIFTED_SINK * h &&
        lowest(over, frames) >= limit &&
        lowest(over, frames, true) >= limit
      ) {
        chosen = over;
        break;
      }
    }
    if (!chosen) continue;
    for (const { c, fc } of chosen.values()) {
      const k = keyOf(c.bone, c.channel, c.index);
      const path = bonePath(c.bone, c.channel);
      for (const key of fc.keyframes)
        if (key.frame === mid || !keyed.has(k))
          w.key(id, path, c.index, key.frame, key.value, key.interpolation);
      keyed.set(k, c);
      curves.delete(k);
    }
    samples.clear();
    posed.clear();
    lifted++;
  }
  return lifted;
}
