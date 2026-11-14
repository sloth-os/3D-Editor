// memory-desk.ts first: it must load before (and without) operators/memory.ts
import { DESK_ACTOR_ESTIMATES } from '../src/operators/memory-desk';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc, fcurveKey } from '../src/doc/scene-doc';
import type { ObjectData, PoseBone } from '../src/doc/types';
import { FrameState } from '../src/eval/frame-state';
import { transformPoint3 } from '../src/math/vec3';
import type { Vec3 } from '../src/math/types';
import { createEditorState, createOperatorRegistry, type OperatorContext } from '../src/operators';
import {
  ANIMAL_GESTURES,
  BUILT_KINDS,
  HUMAN_GESTURES,
  HUMANOID_KINDS,
  POSE_LAYERS,
  actorInfo,
  applyPose,
  createActor,
  isGesture,
  mount,
  moveAlongPath,
  type ActorKind,
} from '../src/desk/characters';
import { keyPose } from '../src/desk/characters/actor';
import { blueprintFor, posedBones } from '../src/desk/characters/kinds';
import { MAT_LIGHT, actorParts, requireActor } from '../src/desk/characters/rig';

/*
 * Film fixes of the desk actors: gestures layered over what the hips and legs do (a seated,
 * kneeling, lying, riding or walking actor waves without standing up) and quadruped ears that read
 * as ears in close-ups.
 */

/** The humanoid gestures (types.ts HUMAN_GESTURES), listed here so the tests do not depend on it. */
const GESTURES = ['reach', 'point', 'wave', 'talk', 'arms_crossed', 'hands_on_hips', 'carry', 'look_up'];
/** Stances a gesture is layered over without the legs moving. */
const LOW = ['sit', 'sit_ground', 'kneel', 'crouch', 'lie'];
const UPPER_BONES = ['spine', 'chest', 'neck', 'head'].concat(
  ...['L', 'R'].map((s) => [`shoulder.${s}`, `upper_arm.${s}`, `forearm.${s}`, `hand.${s}`]),
);
const LOWER_BONES = ['hips'].concat(
  ...['L', 'R'].map((s) => [`thigh.${s}`, `shin.${s}`, `foot.${s}`, `toe.${s}`]),
);
const ANIMAL_LOWER = ['hips'].concat(
  ...['FL', 'FR', 'BL', 'BR'].map((l) => [`upper_leg.${l}`, `lower_leg.${l}`, `foot.${l}`]),
);
/** Paths of the channels an upper-body layer may key (humanoid, quadruped). */
const UPPER =
  /^pose\.bones\["(spine|chest|neck|head|shoulder\.[LR]|upper_arm\.[LR]|forearm\.[LR]|hand\.[LR])"\]/;
const UPPER_ANIMAL = /^pose\.bones\["(neck|head)"\]/;
const DEG = Math.PI / 180;

function actor(kind: ActorKind, location: Vec3 = [0, 0, 0]) {
  const doc = SceneDoc.create({ empty: true });
  return { doc, id: createActor(doc, { kind, location }).actor };
}

/** An actor's F-curves (without ids) whose path `keep` accepts, in a stable order. */
function curves(doc: SceneDoc, id: string, keep: (path: string) => boolean): string {
  return JSON.stringify(
    doc
      .listFCurves(id)
      .filter((fc) => keep(fc.path))
      .map((fc) => [`${fc.path}#${fc.index}`, fc.keyframes, fc.extrapolation ?? null] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
}

/** The actor's pose bones as evaluated at `frame`. */
const bonesAt = (doc: SceneDoc, id: string, frame: number) =>
  (new FrameState(doc, frame).get<ObjectData>('object', id)?.pose?.bones ?? {}) as Record<string, PoseBone>;

/** A pose of the actor's kind, as applyPose keys it. */
function posed(doc: SceneDoc, id: string, pose: string): Record<string, PoseBone> {
  const meta = requireActor(doc, id);
  const kind = meta.kind as ActorKind;
  return posedBones(kind, doc.getArmature(meta.armature)!, blueprintFor(kind, meta.height), pose);
}

const rot = (b: PoseBone | undefined) => (b?.rotation_euler ?? [0, 0, 0]) as Vec3;
/** A bone channel's F-curve path: its bone and channel. */
const BONE_PATH = /^pose\.bones\["([^"]+)"\]\.(rotation_euler|location|scale)$/;
/** Largest difference (radians, wrapped) between two bones' rotations. */
const rotGap = (a: PoseBone | undefined, b: PoseBone | undefined) =>
  Math.max(
    ...[0, 1, 2].map((i) =>
      Math.abs(Math.atan2(Math.sin(rot(a)[i] - rot(b)[i]), Math.cos(rot(a)[i] - rot(b)[i]))),
    ),
  );
/** Largest difference between two poses over `bones` (rotations; the hips' location per metre too). */
function poseGap(a: Record<string, PoseBone>, b: Record<string, PoseBone>, bones: string[]): number {
  let gap = 0;
  for (const bone of bones) {
    gap = Math.max(gap, rotGap(a[bone], b[bone]));
    const la = (a[bone]?.location ?? [0, 0, 0]) as Vec3;
    const lb = (b[bone]?.location ?? [0, 0, 0]) as Vec3;
    for (let i = 0; i < 3; i++) gap = Math.max(gap, Math.abs(la[i] - lb[i]));
  }
  return gap;
}

/** The parts a humanoid layer keys as a whole: the posture and each arm. */
const PARTS = [
  ['spine', 'chest', 'neck', 'head'],
  ...['L', 'R'].map((s) => [`shoulder.${s}`, `upper_arm.${s}`, `forearm.${s}`, `hand.${s}`]),
];

/**
 * The parts a gesture moves away from standing (`moved`), how many of them show it at a frame
 * (`shown`), and whether every other part holds the stance's values (`rest`: a part the gesture
 * leaves, or one it would put into the ground).
 */
function parts(
  at: Record<string, PoseBone>,
  gesture: Record<string, PoseBone>,
  stand: Record<string, PoseBone>,
  stance: Record<string, PoseBone>,
) {
  const moved = PARTS.filter((part) => part.some((b) => rotGap(gesture[b], stand[b]) > 1e-9));
  const shows = (part: string[]) => part.every((b) => rotGap(at[b], gesture[b]) < 1e-6);
  const holds = (part: string[]) => part.every((b) => rotGap(at[b], stance[b]) < 1e-6);
  return {
    moved: moved.length,
    shown: moved.filter(shows).length,
    rest: PARTS.every((part) => (moved.includes(part) && shows(part)) || holds(part)),
  };
}

/** The gesture parts an adult's stance leaves as they were because they would sink into the ground. */
const SUNK: Record<string, number> = { 'sit_ground + talk': 1, 'lie + look_up': 1 };

describe('desk actors: gestures layered over the legs', () => {
  it('classifies every pose: the gestures move only the upper body, the rest is full-body', () => {
    expect([...HUMAN_GESTURES]).toEqual(GESTURES);
    expect([...ANIMAL_GESTURES]).toEqual(['look_up']);
    expect([...POSE_LAYERS]).toEqual(['auto', 'full', 'upper']);
    for (const pose of ['stand', 'walk', 'run', 'sit', 'crouch', 'kneel', 'lie', 'idle', 'throw', 'kick'])
      expect(isGesture('adult', pose), pose).toBe(false);
    for (const pose of ['jump', 'ride', 'sit_ground']) expect(isGesture('child', pose), pose).toBe(false);
    for (const pose of GESTURES) expect(isGesture('elder', pose), pose).toBe(true);
    expect(isGesture('dog', 'look_up')).toBe(true);
    for (const pose of ['stand', 'walk', 'trot', 'gallop', 'sit', 'lie', 'eat'])
      expect(isGesture('horse', pose), pose).toBe(false);
    // a gesture moves no hips or leg bone away from standing
    const { doc, id } = actor('adult');
    const stand = posed(doc, id, 'stand');
    for (const g of GESTURES) expect(poseGap(posed(doc, id, g), stand, LOWER_BONES), g).toBeLessThan(1e-9);
  });

  it('keys only the upper body over a sitting, kneeling, crouching or lying actor', () => {
    for (const stance of LOW) {
      const { doc, id } = actor('adult');
      applyPose(doc, id, stance, { frame: 10 });
      const lower = curves(doc, id, (p) => !UPPER.test(p));
      const base = posed(doc, id, stance);
      const stand = posed(doc, id, 'stand');
      GESTURES.forEach((g, n) => {
        // one gesture after another on the same actor: each replaces the one before
        const frame = 40 + 60 * n;
        const r = keyPose(doc, id, g, { frame, hold_frames: 20 });
        const what = `${stance} + ${g}`;
        expect(r, what).toMatchObject({ frames: [frame - 6, frame, frame + 20], layer: 'upper' });
        // a part held back because it would go into the ground is named, with a warning
        expect(r.held.length, what).toBe(SUNK[what] ?? 0);
        expect(r.warning !== undefined, what).toBe(Boolean(SUNK[what]));
        // the hips, legs and the actor's place keep their keys
        expect(
          curves(doc, id, (p) => !UPPER.test(p)),
          what,
        ).toBe(lower);
        const at = bonesAt(doc, id, frame);
        expect(poseGap(at, base, LOWER_BONES), what).toBeLessThan(1e-9);
        // the gesture shows (the posture and each arm it moves, as a whole), the parts it leaves
        // are the stance's (the earlier gesture's are gone), and so is a part it would put into
        // the ground: the left hand of a talk from a seat on the ground, the head of a lying
        // actor tipped back to look up
        const p = parts(at, posed(doc, id, g), stand, base);
        expect(p.shown, what).toBe(p.moved - (SUNK[what] ?? 0));
        expect(p.rest, what).toBe(true);
        expect(poseGap(bonesAt(doc, id, frame + 20), at, UPPER_BONES), what).toBeLessThan(1e-9);
      });
    }
  });

  it("a part a gesture would put into the ground takes the stance's values, not an earlier gesture's", () => {
    const { doc, id } = actor('adult');
    applyPose(doc, id, 'sit_ground', { frame: 10 });
    applyPose(doc, id, 'arms_crossed', { frame: 40, layer: 'auto' });
    // talking from the ground: its left hand would hang into it, so that arm props the seat again
    expect(keyPose(doc, id, 'talk', { frame: 80, hold_frames: 10 }).layer).toBe('upper');
    const at = bonesAt(doc, id, 80);
    const sit = posed(doc, id, 'sit_ground');
    expect(poseGap(at, sit, PARTS[1])).toBeLessThan(1e-9);
    expect(poseGap(at, posed(doc, id, 'talk'), PARTS[2])).toBeLessThan(1e-9);
    const h = requireActor(doc, id).height;
    expect(actorInfo(new FrameState(doc, 80), doc, id).bounds.min[2]).toBeGreaterThan(-0.02 * h);
  });

  it('keys no channel a layered gesture leaves as it is', () => {
    for (const stance of LOW)
      for (const g of GESTURES) {
        const { doc, id } = actor('adult');
        applyPose(doc, id, stance, { frame: 10 });
        const before = new Map(doc.listFCurves(id).map((fc) => [`${fc.path}#${fc.index}`, fc.keyframes]));
        const was = bonesAt(doc, id, 40);
        keyPose(doc, id, g, { frame: 40, hold_frames: 20, layer: 'auto' });
        const at = bonesAt(doc, id, 40);
        for (const fc of doc.listFCurves(id)) {
          const old = before.get(`${fc.path}#${fc.index}`);
          if (old && JSON.stringify(old) === JSON.stringify(fc.keyframes)) continue;
          // a channel keyed again takes another value at the pose's frame, or is lifted in the
          // middle of its blend (blend.ts): a key that holds a value where it is costs every frame
          const [, bone, channel] = BONE_PATH.exec(fc.path) ?? [];
          const value = (b: Record<string, PoseBone>) =>
            ((b[bone]?.[channel as 'rotation_euler'] ?? [0, 0, 0]) as Vec3)[fc.index];
          const lifted = fc.keyframes.some((k) => k.frame > 34 && k.frame < 40);
          expect(
            lifted || Math.abs(value(at) - value(was)) > 1e-9,
            `${stance} + ${g}: ${fc.path}#${fc.index}`,
          ).toBe(true);
        }
      }
  });

  it('layers over hips held low in a pose of no stance (a seat with a leg moved by hand)', () => {
    const { doc, id } = actor('adult');
    applyPose(doc, id, 'sit', { frame: 10 });
    // the left thigh lifted by hand at the sit's key: the legs hold none of the stances
    const key = fcurveKey({
      target_type: 'object',
      target_id: id,
      path: 'pose.bones["thigh.L"].rotation_euler',
      index: 0,
    });
    const fc = doc.getFCurve(key)!;
    doc.setFCurve({
      ...fc,
      keyframes: fc.keyframes.map((k) => (k.frame === 10 ? { ...k, value: k.value - 0.3 } : k)),
    });
    const lower = curves(doc, id, (p) => !UPPER.test(p));
    const legs = bonesAt(doc, id, 40);
    expect(poseGap(legs, posed(doc, id, 'sit'), LOWER_BONES)).toBeGreaterThan(0.29);
    expect(keyPose(doc, id, 'wave', { frame: 40, hold_frames: 20 }).layer).toBe('upper');
    expect(curves(doc, id, (p) => !UPPER.test(p))).toBe(lower);
    expect(poseGap(bonesAt(doc, id, 50), legs, LOWER_BONES)).toBeLessThan(1e-9);
    // the stored pose of an actor without keys likewise
    const still = actor('adult');
    applyPose(still.doc, still.id, 'kneel');
    const bones = still.doc.getObject(still.id)!.pose.bones as Record<string, PoseBone>;
    const thigh = bones['thigh.L'];
    const bent = [rot(thigh)[0] - 0.3, rot(thigh)[1], rot(thigh)[2]] as Vec3;
    still.doc.updateObject(still.id, {
      pose: { bones: { ...bones, 'thigh.L': { ...thigh, rotation_euler: bent } } },
    });
    expect(keyPose(still.doc, still.id, 'point', { layer: 'auto' }).layer).toBe('upper');
    const stored = still.doc.getObject(still.id)!.pose.bones as Record<string, PoseBone>;
    expect(rotGap(stored['thigh.L'], { ...thigh, rotation_euler: bent })).toBeLessThan(1e-9);
    expect(
      poseGap(stored, posed(still.doc, still.id, 'kneel'), ['hips', 'thigh.R', 'shin.L', 'shin.R']),
    ).toBeLessThan(1e-9);
  });

  it('leaves the arm it does not use moving with legs that get up and sit again inside its frames', () => {
    const { doc, id } = actor('adult');
    applyPose(doc, id, 'sit_ground', { frame: 10 });
    applyPose(doc, id, 'stand', { frame: 50 });
    applyPose(doc, id, 'sit_ground', { frame: 60 });
    const up = bonesAt(doc, id, 50);
    const lower = curves(doc, id, (p) => !UPPER.test(p));
    // seated at 40, 60 and 70, standing at 50
    expect(keyPose(doc, id, 'wave', { frame: 60, blend_frames: 20, hold_frames: 10 }).layer).toBe('upper');
    expect(curves(doc, id, (p) => !UPPER.test(p))).toBe(lower);
    expect(poseGap(bonesAt(doc, id, 50), up, [...LOWER_BONES, ...PARTS[1]])).toBeLessThan(1e-9);
  });

  it('keys exactly what a full pose keys on an actor standing still', () => {
    for (const g of GESTURES) {
      const auto = actor('adult');
      const full = actor('adult');
      for (const a of [auto, full]) {
        // a stance before the gesture, stood up from long before it
        applyPose(a.doc, a.id, 'kneel', { frame: 10 });
        applyPose(a.doc, a.id, 'stand', { frame: 30 });
      }
      expect(keyPose(auto.doc, auto.id, g, { frame: 80, hold_frames: 12 }).layer, g).toBe('full');
      keyPose(full.doc, full.id, g, { frame: 80, hold_frames: 12, layer: 'full' });
      expect(
        curves(auto.doc, auto.id, () => true),
        g,
      ).toBe(curves(full.doc, full.id, () => true));
      // and on an actor never posed
      const fresh = [actor('woman'), actor('woman')];
      applyPose(fresh[0].doc, fresh[0].id, g, { frame: 20, layer: 'auto' });
      applyPose(fresh[1].doc, fresh[1].id, g, { frame: 20, layer: 'full' });
      expect(
        curves(fresh[0].doc, fresh[0].id, () => true),
        g,
      ).toBe(curves(fresh[1].doc, fresh[1].id, () => true));
    }
    // a quadruped standing still raises its head in full too
    const dogs = [actor('dog'), actor('dog')];
    expect(keyPose(dogs[0].doc, dogs[0].id, 'look_up', { frame: 20 }).layer).toBe('full');
    keyPose(dogs[1].doc, dogs[1].id, 'look_up', { frame: 20, layer: 'full' });
    expect(curves(dogs[0].doc, dogs[0].id, () => true)).toBe(curves(dogs[1].doc, dogs[1].id, () => true));
  });

  it('a held pose leaves keys that hold the legs where they are: a later gesture standing still is full', () => {
    // a full pose keyed with hold_frames keys every leg channel that has keys (any actor that has
    // walked, sat or knelt) at its hold's end with the value it holds: that key moves nothing
    for (const g of GESTURES) {
      const auto = actor('adult');
      const full = actor('adult');
      let at = 0;
      for (const a of [auto, full]) {
        const r = moveAlongPath(a.doc, a.id, [[0, -4, 0]], { frame_start: 1 });
        at = Math.ceil(r.frame_end) + 60;
        applyPose(a.doc, a.id, 'point', { frame: at, hold_frames: 24 });
      }
      // the gesture's blend (6 frames) covers the point's hold end
      expect(keyPose(auto.doc, auto.id, g, { frame: at + 28 }).layer, g).toBe('full');
      keyPose(full.doc, full.id, g, { frame: at + 28, layer: 'full' });
      expect(
        curves(auto.doc, auto.id, () => true),
        g,
      ).toBe(curves(full.doc, full.id, () => true));
      // so the pointing arm does not stay up
      const gesture = posed(auto.doc, auto.id, g);
      expect(poseGap(bonesAt(auto.doc, auto.id, at + 528), gesture, PARTS[2]), g).toBeLessThan(1e-9);
    }
    // the same after a stance stood up from, and a held gesture whose end the next blend covers
    const auto = actor('adult');
    const full = actor('adult');
    for (const a of [auto, full]) {
      applyPose(a.doc, a.id, 'kneel', { frame: 10 });
      applyPose(a.doc, a.id, 'stand', { frame: 30 });
      applyPose(a.doc, a.id, 'arms_crossed', { frame: 50, hold_frames: 30 });
    }
    expect(keyPose(auto.doc, auto.id, 'look_up', { frame: 85, blend_frames: 10 }).layer).toBe('full');
    keyPose(full.doc, full.id, 'look_up', { frame: 85, blend_frames: 10, layer: 'full' });
    expect(curves(auto.doc, auto.id, () => true)).toBe(curves(full.doc, full.id, () => true));
  });

  it("a gesture after a held stance and a held gesture replaces the earlier gesture's arms", () => {
    const { doc, id } = actor('adult');
    // the seat's hold end (60) and the arms' hold end (56) both fall in look_up's blend (56–64)
    applyPose(doc, id, 'sit_ground', { frame: 10, hold_frames: 50 });
    applyPose(doc, id, 'arms_crossed', { frame: 30, hold_frames: 26, layer: 'auto' });
    const lower = curves(doc, id, (p) => !UPPER.test(p));
    expect(keyPose(doc, id, 'look_up', { frame: 64, blend_frames: 8 }).layer).toBe('upper');
    expect(curves(doc, id, (p) => !UPPER.test(p))).toBe(lower);
    const sit = posed(doc, id, 'sit_ground');
    for (const f of [64, 200]) {
      const at = bonesAt(doc, id, f);
      // both arms back on the ground behind the seat, as the stance has them
      expect(poseGap(at, sit, [...PARTS[1], ...PARTS[2]]), `${f}`).toBeLessThan(1e-9);
      expect(poseGap(at, sit, LOWER_BONES), `${f}`).toBeLessThan(1e-9);
    }
  });

  it("'full' stands a seated actor up, 'upper' layers over a standing one, and a later stance still applies", () => {
    const { doc, id } = actor('man');
    applyPose(doc, id, 'sit', { frame: 10 });
    expect(keyPose(doc, id, 'wave', { frame: 40, layer: 'full' }).layer).toBe('full');
    expect(
      poseGap(bonesAt(doc, id, 40), posed(doc, id, 'wave'), [...LOWER_BONES, ...UPPER_BONES]),
    ).toBeLessThan(1e-9);
    const standing = actor('man');
    applyPose(standing.doc, standing.id, 'idle', { frame: 10 });
    const lower = curves(standing.doc, standing.id, (p) => !UPPER.test(p));
    expect(keyPose(standing.doc, standing.id, 'point', { frame: 40, layer: 'upper' }).layer).toBe('upper');
    expect(curves(standing.doc, standing.id, (p) => !UPPER.test(p))).toBe(lower);
    // a full-body pose after a layered gesture keys every bone again
    const seated = actor('woman');
    applyPose(seated.doc, seated.id, 'kneel', { frame: 10 });
    applyPose(seated.doc, seated.id, 'talk', { frame: 40, layer: 'auto' });
    applyPose(seated.doc, seated.id, 'stand', { frame: 80, blend_frames: 12 });
    expect(
      poseGap(bonesAt(seated.doc, seated.id, 80), posed(seated.doc, seated.id, 'stand'), LOWER_BONES),
    ).toBeLessThan(1e-9);
    expect(() => keyPose(doc, id, 'wave', { frame: 90, layer: 'legs' as never })).toThrow(
      /layer must be one of/,
    );
  });

  it('blends sit → gesture → sit → stand without moving the legs before the stand-up', () => {
    const { doc, id } = actor('adult');
    applyPose(doc, id, 'sit_ground', { frame: 10 });
    const layers = [
      keyPose(doc, id, 'reach', { frame: 40, blend_frames: 8 }).layer,
      keyPose(doc, id, 'sit_ground', { frame: 80, blend_frames: 8 }).layer,
      keyPose(doc, id, 'stand', { frame: 120, blend_frames: 12 }).layer,
    ];
    expect(layers).toEqual(['upper', 'full', 'full']);
    const sit = posed(doc, id, 'sit_ground');
    const reach = posed(doc, id, 'reach');
    let prev = bonesAt(doc, id, 10);
    let legStep = 0;
    let armStep = 0;
    for (let f = 11; f <= 136; f++) {
      const b = bonesAt(doc, id, f);
      // the legs hold the seat until the stand-up blend starts (frame 108)
      if (f <= 108) expect(poseGap(b, sit, LOWER_BONES), `frame ${f}`).toBeLessThan(1e-9);
      legStep = Math.max(legStep, poseGap(b, prev, LOWER_BONES));
      armStep = Math.max(armStep, poseGap(b, prev, UPPER_BONES));
      prev = b;
    }
    // no pops: every frame moves a joint less than the blends need (measured 11.4° and 23.9°)
    expect(legStep).toBeLessThan(15 * DEG);
    expect(armStep).toBeLessThan(30 * DEG);
    expect(parts(bonesAt(doc, id, 60), reach, posed(doc, id, 'stand'), sit)).toEqual({
      moved: 2,
      shown: 2,
      rest: true,
    });
    expect(poseGap(bonesAt(doc, id, 90), sit, UPPER_BONES)).toBeLessThan(1e-9);
    expect(
      poseGap(bonesAt(doc, id, 136), posed(doc, id, 'stand'), [...LOWER_BONES, ...UPPER_BONES]),
    ).toBeLessThan(1e-9);
  });

  it('keeps the hands out of the ground at every frame of a blend from a seat on the ground and back', () => {
    // the arm swings from behind the seat to the front (and back): blended per joint angle it
    // would pass straight down from a shoulder half a metre up, through the ground
    for (const kind of ['adult', 'child', 'toddler'] as ActorKind[])
      for (const g of ['reach', 'point', 'carry', 'arms_crossed']) {
        const { doc, id } = actor(kind);
        applyPose(doc, id, 'sit_ground', { frame: 10 });
        expect(keyPose(doc, id, g, { frame: 40, hold_frames: 20 }).layer).toBe('upper');
        keyPose(doc, id, 'sit_ground', { frame: 80 });
        const h = requireActor(doc, id).height;
        const floor = Math.min(0, actorInfo(new FrameState(doc, 10), doc, id).bounds.min[2]);
        const sit = posed(doc, id, 'sit_ground');
        let prev = bonesAt(doc, id, 32);
        for (let f = 32; f <= 90; f++) {
          const what = `${kind} ${g} frame ${f}`;
          expect(actorInfo(new FrameState(doc, f), doc, id).bounds.min[2], what).toBeGreaterThan(
            floor - 0.02 * h,
          );
          const b = bonesAt(doc, id, f);
          // the legs stay on the ground, and the lift is a swell, not a jerk (default 6-frame
          // blends move a joint up to 31° a frame without it)
          expect(poseGap(b, sit, LOWER_BONES), what).toBeLessThan(1e-9);
          expect(poseGap(b, prev, UPPER_BONES), what).toBeLessThan(36 * DEG);
          prev = b;
        }
        // the gesture and the seat are reached as keyed
        expect(poseGap(bonesAt(doc, id, 50), posed(doc, id, g), PARTS[2]), `${kind} ${g}`).toBeLessThan(1e-9);
        expect(poseGap(bonesAt(doc, id, 90), sit, UPPER_BONES), `${kind} ${g}`).toBeLessThan(1e-9);
      }
  });

  it('a rider on a walking mount keeps its riding legs and its place while it waves', () => {
    const doc = SceneDoc.create({ empty: true });
    const pony = createActor(doc, { kind: 'pony', location: [0, 0, 0] }).actor;
    const rider = createActor(doc, { kind: 'child', location: [1, 0, 0] }).actor;
    mount(doc, rider, pony, { frame: 5, dismount_frame: 200 });
    moveAlongPath(doc, pony, [[0, -6, 0]], { frame_start: 10 });
    const lower = curves(doc, rider, (p) => !UPPER.test(p));
    // the legs round the pony's barrel (the ride pose fitted to the mount)
    const legs = [34, 40, 50, 60].map((f) => bonesAt(doc, rider, f));
    expect(keyPose(doc, rider, 'wave', { frame: 40, hold_frames: 20 }).layer).toBe('upper');
    expect(curves(doc, rider, (p) => !UPPER.test(p))).toBe(lower);
    [34, 40, 50, 60].forEach((f, i) =>
      expect(poseGap(bonesAt(doc, rider, f), legs[i], LOWER_BONES), `${f}`).toBeLessThan(1e-9),
    );
    const wave = posed(doc, rider, 'wave');
    // the waving arm up, the other on the reins as it rode
    expect(
      parts(bonesAt(doc, rider, 50), wave, posed(doc, rider, 'stand'), posed(doc, rider, 'ride')),
    ).toEqual({
      moved: 2,
      shown: 2,
      rest: true,
    });
    expect(poseGap(bonesAt(doc, rider, 30), legs[0], LOWER_BONES)).toBeLessThan(1e-9);
    // still on the saddle: its feet off the ground
    expect(actorInfo(new FrameState(doc, 50), doc, rider).bounds.min[2]).toBeGreaterThan(0.2);
    // a gesture replaces an earlier one: after crossed arms, a wave puts the left hand back on the reins
    expect(keyPose(doc, rider, 'arms_crossed', { frame: 100, hold_frames: 10 }).layer).toBe('upper');
    expect(keyPose(doc, rider, 'wave', { frame: 140, hold_frames: 10 }).layer).toBe('upper');
    expect(curves(doc, rider, (p) => !UPPER.test(p))).toBe(lower);
    const at = bonesAt(doc, rider, 140);
    expect(poseGap(at, posed(doc, rider, 'ride'), PARTS[1])).toBeLessThan(1e-9);
    expect(poseGap(at, wave, PARTS[2])).toBeLessThan(1e-9);
  });

  it('a walking actor gestures without changing its steps; standing still again, in full', () => {
    const { doc, id } = actor('adult');
    const r = moveAlongPath(doc, id, [[0, -8, 0]], { frame_start: 1 });
    const steps = curves(doc, id, (p) => !UPPER.test(p));
    const mid = Math.round(r.frame_end / 2);
    expect(keyPose(doc, id, 'wave', { frame: mid, hold_frames: 24 }).layer).toBe('upper');
    expect(curves(doc, id, (p) => !UPPER.test(p))).toBe(steps);
    const wave = posed(doc, id, 'wave');
    expect(rotGap(bonesAt(doc, id, mid + 10)['upper_arm.R'], wave['upper_arm.R'])).toBeLessThan(1e-6);
    // a later move from a seat: sat at the end of the walk, it talks, then gets up and walks on
    const end = Math.ceil(r.frame_end) + 40;
    applyPose(doc, id, 'sit_ground', { frame: end });
    const seated = curves(doc, id, (p) => !UPPER.test(p));
    expect(keyPose(doc, id, 'talk', { frame: end + 30, hold_frames: 20 }).layer).toBe('upper');
    expect(curves(doc, id, (p) => !UPPER.test(p))).toBe(seated);
    const sit = posed(doc, id, 'sit_ground');
    expect(poseGap(bonesAt(doc, id, end + 40), sit, LOWER_BONES)).toBeLessThan(1e-9);
    const on = moveAlongPath(doc, id, [[3, -8, 0]], { frame_start: end + 70 });
    const there = actorInfo(new FrameState(doc, on.frame_end + 20), doc, id);
    expect(Math.hypot(there.feet[0] - 3, there.feet[1] + 8)).toBeLessThan(0.15);
    expect(poseGap(bonesAt(doc, id, on.frame_end + 20), posed(doc, id, 'stand'), LOWER_BONES)).toBeLessThan(
      0.05,
    );
    // standing still long after the walk, a gesture is a full pose again
    expect(keyPose(doc, id, 'point', { frame: on.frame_end + 60 }).layer).toBe('full');
  });

  it('a pose without a frame layers over the stored pose', () => {
    const { doc, id } = actor('elder');
    applyPose(doc, id, 'kneel');
    applyPose(doc, id, 'wave', { layer: 'auto' });
    const stored = doc.getObject(id)!.pose.bones as Record<string, PoseBone>;
    expect(poseGap(stored, posed(doc, id, 'kneel'), LOWER_BONES)).toBeLessThan(1e-9);
    expect(rotGap(stored['upper_arm.R'], posed(doc, id, 'wave')['upper_arm.R'])).toBeLessThan(1e-9);
    expect(keyPose(doc, id, 'stand').layer).toBe('full');
    expect(keyPose(doc, id, 'point').layer).toBe('full');
  });

  it('a quadruped raises its head over a sit or a lie, its legs as they were', () => {
    for (const kind of ['dog', 'horse', 'cat'] as ActorKind[])
      for (const stance of ['sit', 'lie']) {
        const { doc, id } = actor(kind);
        applyPose(doc, id, stance, { frame: 10 });
        const lower = curves(doc, id, (p) => !UPPER_ANIMAL.test(p));
        expect(keyPose(doc, id, 'look_up', { frame: 40 }).layer, `${kind} ${stance}`).toBe('upper');
        expect(
          curves(doc, id, (p) => !UPPER_ANIMAL.test(p)),
          `${kind} ${stance}`,
        ).toBe(lower);
        const at = bonesAt(doc, id, 40);
        expect(poseGap(at, posed(doc, id, stance), ANIMAL_LOWER)).toBeLessThan(1e-9);
        const up = posed(doc, id, 'look_up');
        expect(poseGap(at, up, ['neck', 'head']), `${kind} ${stance}`).toBeLessThan(1e-9);
      }
  });

  it('keeps every humanoid above the ground while it gestures from a low stance', () => {
    for (const kind of HUMANOID_KINDS)
      for (const stance of LOW) {
        const { doc, id } = actor(kind);
        applyPose(doc, id, stance, { frame: 10 });
        const h = requireActor(doc, id).height;
        // the stance's own lowest point (a lying actor's arm may already touch it)
        const floor = Math.min(0, actorInfo(new FrameState(doc, 10), doc, id).bounds.min[2]);
        GESTURES.forEach((g, n) => {
          const frame = 40 + 40 * n;
          keyPose(doc, id, g, { frame, hold_frames: 10 });
          const low = actorInfo(new FrameState(doc, frame), doc, id).bounds.min[2];
          expect(low, `${kind} ${stance} + ${g}`).toBeGreaterThan(floor - 0.025 * h);
        });
      }
  });

  it('sits on the ground with the seat on the ground', () => {
    for (const kind of HUMANOID_KINDS) {
      const { doc, id } = actor(kind);
      applyPose(doc, id, 'sit_ground');
      const h = requireActor(doc, id).height;
      const fs = new FrameState(doc, 1);
      const info = actorInfo(fs, doc, id);
      // grounded: nothing below the floor, the pelvis (the hips' part) down on it
      expect(info.bounds.min[2], kind).toBeGreaterThan(-0.01 * h);
      const pelvis = actorParts(doc, id).get('hips')!;
      const mesh = doc.getMesh(doc.getObject(pelvis)!.data!)!;
      const w = fs.world(pelvis)!;
      let low = Infinity;
      for (let i = 0; i < mesh.positions.length; i += 3)
        low = Math.min(
          low,
          transformPoint3(w, [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]])[2],
        );
      expect(low, kind).toBeLessThan(0.03 * h);
      // and sitting up: the head well above the seat
      expect(info.head_top[2] / h, kind).toBeGreaterThan(0.45);
    }
  });

  it('applyPose keys the whole figure unless asked to layer (rideo marks); desk.actor_pose layers', () => {
    for (const stance of LOW)
      for (const g of ['reach', 'point', 'wave']) {
        // a rideo 'point' mark after a 'sit' mark is a standing pointing figure (the import keys
        // each mark with applyPose and no layer, blend 0, at the shot's start)
        const { doc, id } = actor('adult');
        applyPose(doc, id, stance, { frame: 1, blend_frames: 0 });
        applyPose(doc, id, g, { frame: 40, blend_frames: 0 });
        const what = `${stance} + ${g}`;
        expect(
          poseGap(bonesAt(doc, id, 40), posed(doc, id, g), [...LOWER_BONES, ...UPPER_BONES]),
          what,
        ).toBeLessThan(1e-9);
        // asked to, it layers; so does the operator by default
        applyPose(doc, id, stance, { frame: 80, blend_frames: 0 });
        applyPose(doc, id, g, { frame: 120, blend_frames: 0, layer: 'auto' });
        expect(poseGap(bonesAt(doc, id, 120), posed(doc, id, stance), LOWER_BONES), what).toBeLessThan(1e-9);
      }
    const reg = createOperatorRegistry();
    expect(reg.parseParams('desk.actor_pose', { actor: 'Ada', pose: 'wave' })).toMatchObject({
      layer: 'auto',
    });
  });

  it('runs as desk.actor_pose: layer parameter, result, one undo step and estimate', () => {
    const doc = SceneDoc.create({ empty: true });
    const reg = createOperatorRegistry();
    const ctx: OperatorContext = {
      doc,
      state: createEditorState(),
      origin: doc.origin,
      source: 'test',
      report: () => undefined,
    };
    const id = createActor(doc, { kind: 'adult', location: [0, 0, 0], name: 'Ada' }).actor;
    applyPose(doc, id, 'sit', { frame: 10 });
    expect(reg.parseParams('desk.actor_pose', { actor: 'Ada', pose: 'wave' })).toMatchObject({
      layer: 'auto',
    });
    const desc = reg.get('desk.actor_pose')!.description;
    expect(desc).toMatch(/layer/);
    const undo = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    const before = curves(doc, id, () => true);
    const params = { actor: 'Ada', pose: 'wave', frame: 40, hold_frames: 20 };
    const parsed = reg.parseParams('desk.actor_pose', params) as Record<string, unknown>;
    const est = DESK_ACTOR_ESTIMATES['desk.actor_pose'](ctx, parsed)!;
    const keys = () => doc.listFCurves(id).reduce((n, fc) => n + fc.keyframes.length, 0);
    const k0 = keys();
    const r = reg.run(ctx, 'desk.actor_pose', params);
    expect(r.ok, r.error).toBe(true);
    expect(r.result).toMatchObject({ object: id, pose: 'wave', frames: [34, 40, 60], layer: 'upper' });
    expect(keys() - k0).toBeLessThanOrEqual(est.keyframes ?? 0);
    expect(undo.undoStack.length).toBe(1);
    undo.undo();
    expect(curves(doc, id, () => true)).toBe(before);
    const full = reg.run(ctx, 'desk.actor_pose', { ...params, layer: 'full' });
    expect(full.result).toMatchObject({ layer: 'full' });
    // a reach from a seat on the ground: the arm lifted out of the ground in the blend keys one
    // key more in its middle, still within the estimate
    const low = createActor(doc, { kind: 'adult', location: [3, 0, 0], name: 'Lo' }).actor;
    applyPose(doc, low, 'sit_ground', { frame: 10 });
    const reach = { actor: 'Lo', pose: 'reach', frame: 50, hold_frames: 20 };
    const parsedReach = reg.parseParams('desk.actor_pose', reach) as Record<string, unknown>;
    const estReach = DESK_ACTOR_ESTIMATES['desk.actor_pose'](ctx, parsedReach)!;
    const lowKeys = () => doc.listFCurves(low).reduce((n, fc) => n + fc.keyframes.length, 0);
    const before2 = lowKeys();
    expect(reg.run(ctx, 'desk.actor_pose', reach).ok).toBe(true);
    const lifted = doc.listFCurves(low).filter((fc) => fc.keyframes.some((k) => k.frame === 47));
    expect(lifted.map((fc) => fc.path)).toEqual(['pose.bones["upper_arm.R"].rotation_euler']);
    expect(lowKeys() - before2).toBeLessThanOrEqual(estReach.keyframes ?? 0);
    const bad = reg.run(ctx, 'desk.actor_pose', { ...params, layer: 'legs' });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('INVALID_PARAMS');
  });

  it('desk.actor_pose names the parts it held back out of the ground and warns, also when it keys nothing', () => {
    const doc = SceneDoc.create({ empty: true });
    const reg = createOperatorRegistry();
    const reports: [string, string][] = [];
    const ctx: OperatorContext = {
      doc,
      state: createEditorState(),
      origin: doc.origin,
      source: 'test',
      report: (level, message) => void reports.push([level, message]),
    };
    const ada = createActor(doc, { kind: 'adult', location: [0, 0, 0], name: 'Ada' }).actor;
    const bo = createActor(doc, { kind: 'adult', location: [3, 0, 0], name: 'Bo' }).actor;
    applyPose(doc, ada, 'lie', { frame: 10 });
    applyPose(doc, bo, 'sit_ground', { frame: 10 });
    const run = (params: Record<string, unknown>) => {
      reports.length = 0;
      const r = reg.run(ctx, 'desk.actor_pose', params);
      expect(r.ok, r.error).toBe(true);
      return r.result;
    };
    // lying on its back, looking up would tip the head into the ground: nothing is keyed, and it says so
    const lying = curves(doc, ada, () => true);
    expect(run({ actor: 'Ada', pose: 'look_up', frame: 40, hold_frames: 20 })).toMatchObject({
      frames: [34, 40, 60],
      layer: 'upper',
      held_back: ['back and head'],
    });
    expect(curves(doc, ada, () => true)).toBe(lying);
    expect(reports).toEqual([
      ['WARNING', "look_up would put Ada's back and head into the ground while Ada lies; nothing was keyed"],
    ]);
    // talking from a seat on the ground, the left hand would hang into it: it props the seat
    expect(run({ actor: 'Bo', pose: 'talk', frame: 40, hold_frames: 20 })).toMatchObject({
      layer: 'upper',
      held_back: ['left arm'],
    });
    expect(reports).toEqual([
      [
        'WARNING',
        "talk would put Bo's left arm into the ground while Bo sits on the ground; that part keeps the sit_ground pose",
      ],
    ]);
    // a gesture that fits, and a full pose, warn about nothing
    expect(run({ actor: 'Bo', pose: 'wave', frame: 80, hold_frames: 20 })).toMatchObject({ held_back: [] });
    expect(run({ actor: 'Ada', pose: 'look_up', frame: 80, layer: 'full' })).toMatchObject({
      layer: 'full',
      held_back: [],
    });
    expect(reports).toEqual([]);
    // the stored pose of an actor without keys likewise
    const still = actor('adult');
    applyPose(still.doc, still.id, 'lie');
    const stored = JSON.stringify(still.doc.getObject(still.id)!.pose);
    const r = keyPose(still.doc, still.id, 'look_up', { layer: 'auto' });
    expect(r).toMatchObject({ frames: [], layer: 'upper', held: ['back and head'] });
    expect(r.warning).toMatch(
      /^look_up would put .+'s back and head into the ground while .+ lies; nothing changed$/,
    );
    expect(JSON.stringify(still.doc.getObject(still.id)!.pose)).toBe(stored);
  });
});

/** The parts of an actor's head mesh that are not joined to each other (its skull, eyes, ears, horns…). */
function headPieces(doc: SceneDoc, actorId: string) {
  const part = actorParts(doc, actorId).get('head')!;
  const mesh = doc.getMesh(doc.getObject(part)!.data!)!;
  const w = new FrameState(doc, 1).world(part)!;
  const pts: Vec3[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3)
    pts.push(transformPoint3(w, [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]));
  const root = pts.map((_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
  for (const f of mesh.faces) for (const v of f) root[find(v)] = find(f[0]);
  const pieces = new Map<number, { area: Map<number, number>; min: Vec3; max: Vec3 }>();
  mesh.faces.forEach((f, fi) => {
    const key = find(f[0]);
    let p = pieces.get(key);
    if (!p)
      pieces.set(
        key,
        (p = {
          area: new Map(),
          min: [Infinity, Infinity, Infinity],
          max: [-Infinity, -Infinity, -Infinity],
        }),
      );
    let a = 0;
    for (let k = 1; k + 1 < f.length; k++) {
      const [o, b, c] = [pts[f[0]], pts[f[k]], pts[f[k + 1]]];
      const u = [b[0] - o[0], b[1] - o[1], b[2] - o[2]];
      const v = [c[0] - o[0], c[1] - o[1], c[2] - o[2]];
      a += 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
    }
    const m = mesh.faceMaterials[fi];
    p.area.set(m, (p.area.get(m) ?? 0) + a);
    for (const vi of f)
      for (let k = 0; k < 3; k++) {
        p.min[k] = Math.min(p.min[k], pts[vi][k]);
        p.max[k] = Math.max(p.max[k], pts[vi][k]);
      }
  });
  return [...pieces.values()].map((p) => {
    const total = [...p.area.values()].reduce((s, a) => s + a, 0);
    const mat = [...p.area.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return { ...p, total, mat };
  });
}

describe('desk actors: quadruped heads', () => {
  const QUADRUPEDS = BUILT_KINDS.filter((k) => !HUMANOID_KINDS.includes(k));

  it("ears are flaps in the head's own colour, as big as an eye or more, one on each side", () => {
    for (const kind of QUADRUPEDS) {
      const doc = SceneDoc.create({ empty: true });
      const id = createActor(doc, { kind, location: [0, 0, 0] }).actor;
      const pieces = headPieces(doc, id).sort((a, b) => b.total - a.total);
      const skull = pieces[0];
      const eye = pieces.findLast((p) => p.mat === MAT_LIGHT)!;
      // besides the skull, pieces in the skull's colour: the ears (not dark, as horns would be)
      const ears = pieces.slice(1).filter((p) => p.mat === skull.mat && p.total > eye.total);
      expect(ears.length, kind).toBeGreaterThanOrEqual(2);
      expect(ears.filter((p) => p.min[0] + p.max[0] > 0).length, kind).toBe(ears.length / 2);
    }
  });

  it("a dog's ears are wide soft flaps at the back of the skull, its tips folded; cattle keep light horns above them", () => {
    for (const kind of ['dog', 'small_dog'] as ActorKind[]) {
      const doc = SceneDoc.create({ empty: true });
      const id = createActor(doc, { kind, location: [0, 0, 0] }).actor;
      const pieces = headPieces(doc, id).sort((a, b) => b.total - a.total);
      const skull = pieces[0];
      const eye = pieces.findLast((p) => p.mat === MAT_LIGHT)!;
      // the left ear: its flaps in the body colour, behind the eyes (the actor faces −Y)
      const ear = pieces.filter((p) => p.mat === skull.mat && p !== skull && p.min[0] + p.max[0] > 0);
      expect(ear.length, kind).toBeGreaterThan(0);
      const min = [0, 1, 2].map((k) => Math.min(...ear.map((p) => p.min[k])));
      const max = [0, 1, 2].map((k) => Math.max(...ear.map((p) => p.max[k])));
      expect(min[1], kind).toBeGreaterThan(eye.max[1]);
      if (kind === 'dog') {
        // as wide across the head as it is tall: a flap, not a cone; its folded top not above
        // the flap by more than a head's radius
        expect(max[0] - min[0]).toBeGreaterThan(0.9 * (max[2] - min[2]));
        expect(ear.length).toBe(2);
        expect(max[2] - skull.max[2]).toBeLessThan(0.5 * (skull.max[0] - skull.min[0]));
      } else {
        // hanging beside the head: no higher than the skull's top
        expect(max[2] - skull.max[2], kind).toBeLessThan(0.01);
      }
    }
    // cattle: light horns between the ears, standing above the skull and the ears
    const doc = SceneDoc.create({ empty: true });
    const cow = createActor(doc, { kind: 'cow', location: [0, 0, 0] }).actor;
    const pieces = headPieces(doc, cow).sort((a, b) => b.total - a.total);
    const skull = pieces[0];
    const horns = pieces.filter((p) => p.mat === MAT_LIGHT && p.max[2] > skull.max[2]);
    const ears = pieces.slice(1).filter((p) => p.mat === skull.mat);
    expect(horns.length).toBe(2);
    expect(ears.length).toBe(2);
    for (const h of horns) expect(h.max[2]).toBeGreaterThan(Math.max(...ears.map((e) => e.max[2])));
  });
});
