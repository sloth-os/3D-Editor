import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import { FrameState } from '../src/eval/frame-state';
import { createCube } from '../src/mesh/primitives';
import { invert4, multiply4 } from '../src/math/mat4';
import { transformPoint3 } from '../src/math/vec3';
import type { Vec3 } from '../src/math/types';
import { OperatorError } from '../src/operators/context';
import { createEditorState, createOperatorRegistry, type OperatorContext } from '../src/operators';
import {
  actorInfo,
  applyPose,
  createActor,
  faceTo,
  holdProp,
  lookAt,
  mount,
  moveAlongPath,
  type ActorKind,
} from '../src/desk/characters';
import { blueprintFor, defaultHeight } from '../src/desk/characters/kinds';
import { restMatrices } from '../src/desk/characters/rig';

/*
 * Actors in motion (spec §8): moves along paths (arrival, facing, planted feet), turns, looks,
 * holds and rides.
 */

const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof OperatorError) return e.code;
    throw e;
  }
  return undefined;
}

function position(doc: SceneDoc, id: string, frame: number): Vec3 {
  const w = new FrameState(doc, frame).world(id)!;
  return [w[12], w[13], w[14]];
}

/** Heading (degrees, 0 = −Y, 90 = +X) of an object at a frame. */
function heading(doc: SceneDoc, id: string, frame: number): number {
  const w = new FrameState(doc, frame).world(id)!;
  return (Math.atan2(-w[4], w[5]) * 180) / Math.PI;
}

const angleDiff = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

function ball(doc: SceneDoc, name: string, at: Vec3, size = 0.12): string {
  return doc.addObject({
    type: 'MESH',
    name,
    location: at,
    data: doc.addMesh(name, createCube({ size })),
  });
}

/**
 * The drift of every planted foot contact over a frame range: each probe on a foot (heel, ball,
 * toe, hoof) is planted while it is within 4 mm of the ground (half-frame samples, less the one at
 * touch-down and the one at lift-off); the result is the largest horizontal distance a planted
 * probe travels during one stance, the number of stances seen and the lowest probe height.
 */
function stanceDrift(
  doc: SceneDoc,
  id: string,
  kind: ActorKind,
  from: number,
  to: number,
  step = 0.5,
): { worst: number; stances: number; lowest: number } {
  const meta = doc.getObject(id)!;
  const arm = doc.getArmature(meta.data!)!;
  const rest = restMatrices(arm.bones);
  const bp = blueprintFor(kind, Number(meta.custom_props!.desk_height_m));
  const probes = bp.probes.filter((p) => p.bone.startsWith('foot.') || p.bone.startsWith('toe.'));
  const tracks: Vec3[][] = probes.map(() => []);
  for (let f = from; f <= to + 1e-9; f += step) {
    const fs = new FrameState(doc, f);
    probes.forEach((p, i) => {
      const b = fs.boneMatrix(id, p.bone)!;
      tracks[i].push(transformPoint3(multiply4(b.matrix, invert4(rest.get(p.bone)!.matrix)), p.point));
    });
  }
  let worst = 0;
  let stances = 0;
  let lowest = Infinity;
  for (const t of tracks) {
    let start = -1;
    for (let k = 0; k <= t.length; k++) {
      if (k < t.length) lowest = Math.min(lowest, t[k][2]);
      const down = k < t.length && t[k][2] < 0.004;
      if (down && start < 0) start = k;
      if (!down && start >= 0) {
        // the samples at touch-down and lift-off are the transitions, not the stance
        if (k - start >= 4) {
          stances++;
          const s0 = start + 1;
          for (let q = s0; q < k - 1; q++)
            worst = Math.max(worst, Math.hypot(t[q][0] - t[s0][0], t[q][1] - t[s0][1]));
        }
        start = -1;
      }
    }
  }
  return { worst, stances, lowest };
}

describe('desk actors: moves', () => {
  it('reaches the last point at frame_end, facing along the path', () => {
    const doc = SceneDoc.create({ empty: true });
    const a = createActor(doc, { kind: 'adult', location: [0, 0, 0], facing_deg: 90 });
    const r = moveAlongPath(
      doc,
      a.actor,
      [
        [3, 0, 0],
        [3, 4, 0],
      ],
      { frame_start: 1 },
    );
    // the length walked: the polyline's 7 m less what rounding its corner saves (a few cm)
    expect(r.length_m).toBeLessThan(7);
    expect(r.length_m).toBeGreaterThan(6.7);
    const end = position(doc, a.actor, r.frame_end);
    expect(Math.hypot(end[0] - 3, end[1] - 4)).toBeLessThan(0.01);
    // along the last segment (+Y is 180° from the front −Y)
    expect(angleDiff(heading(doc, a.actor, r.frame_end), 180)).toBeLessThan(3);
    // half way along the first segment it walks +X
    expect(angleDiff(heading(doc, a.actor, 1 + (r.frame_end - 1) * 0.2), 90)).toBeLessThan(10);
    // and it stays there once the steps have closed
    expect(dist(position(doc, a.actor, r.frame_end + 60), end)).toBeLessThan(1e-6);
  });

  it('arrives at a given frame_end, turning on the spot first when the path is behind it', () => {
    const doc = SceneDoc.create({ empty: true });
    const a = createActor(doc, { kind: 'woman', location: [0, 0, 0], facing_deg: 0 });
    // the path runs +Y: behind a woman facing −Y
    const r = moveAlongPath(doc, a.actor, [[0, 5, 0]], { frame_start: 10, frame_end: 130 });
    expect(r.frame_end).toBeCloseTo(130, 1);
    const end = position(doc, a.actor, 130);
    expect(Math.hypot(end[0], end[1] - 5)).toBeLessThan(0.01);
    expect(angleDiff(heading(doc, a.actor, 130), 180)).toBeLessThan(3);
    // still at the start before the move, then turned round before stepping off
    expect(dist(position(doc, a.actor, 10), [0, 0, 0])).toBeLessThan(1e-6);
    expect(angleDiff(heading(doc, a.actor, 10), 0)).toBeLessThan(1e-3);
  });

  it('keeps planted feet within 3 cm through every stance of a straight walk and run', () => {
    for (const [kind, gait, x] of [
      ['adult', 'walk', 6],
      ['adult', 'run', 10],
      ['horse', 'walk', 8],
      ['horse', 'trot', 10],
      ['dog', 'gallop', 10],
    ] as [ActorKind, string, number][]) {
      const doc = SceneDoc.create({ empty: true });
      const a = createActor(doc, { kind, location: [0, 0, 0], facing_deg: 90 });
      const r = moveAlongPath(doc, a.actor, [[x, 0, 0]], { frame_start: 1, gait });
      const d = stanceDrift(doc, a.actor, kind, 1, r.frame_end + 12);
      expect(d.stances, `${kind} ${gait}`).toBeGreaterThan(4);
      expect(d.worst, `${kind} ${gait}`).toBeLessThan(0.03);
      // feet do not sink into the ground
      expect(d.lowest, `${kind} ${gait}`).toBeGreaterThan(-0.015);
    }
  });

  it('is deterministic, and refuses bad paths, frames, speeds and gaits', () => {
    const keys = () => {
      const doc = SceneDoc.create({ empty: true });
      const a = createActor(doc, { kind: 'pony', location: [0, 0, 0] });
      moveAlongPath(
        doc,
        a.actor,
        [
          [2, -3, 0],
          [5, -3, 0],
        ],
        { frame_start: 1, gait: 'trot' },
      );
      const out: number[] = [];
      for (const v of doc.map('fcurves').values())
        for (const k of (v as { keyframes: { frame: number; value: number }[] }).keyframes)
          out.push(k.frame, k.value);
      return out;
    };
    expect(keys()).toEqual(keys());
    const doc = SceneDoc.create({ empty: true });
    const a = createActor(doc, { kind: 'adult', location: [0, 0, 0] });
    expect(code(() => moveAlongPath(doc, a.actor, [], { frame_start: 1 }))).toBe('INVALID_PARAMS');
    expect(code(() => moveAlongPath(doc, a.actor, [[1, 0, 0]], { frame_start: 10, frame_end: 5 }))).toBe(
      'INVALID_PARAMS',
    );
    expect(code(() => moveAlongPath(doc, a.actor, [[1, 0, 0]], { frame_start: 1, speed_mps: 0 }))).toBe(
      'INVALID_PARAMS',
    );
    expect(code(() => moveAlongPath(doc, a.actor, [[1, 0, 0]], { frame_start: 1, gait: 'trot' }))).toBe(
      'INVALID_PARAMS',
    );
    expect(code(() => moveAlongPath(doc, a.actor, [[Number.NaN, 0, 0]], { frame_start: 1 }))).toBe(
      'INVALID_PARAMS',
    );
    // a path that ends where the actor stands keys nothing
    const r = moveAlongPath(doc, a.actor, [[0, 0, 0]], { frame_start: 1 });
    expect(r.length_m).toBe(0);
    expect(doc.map('fcurves').size).toBe(0);
  });

  it('ends in the pose it is asked for', () => {
    const doc = SceneDoc.create({ empty: true });
    const a = createActor(doc, { kind: 'adult', location: [0, 0, 0], facing_deg: 90 });
    const r = moveAlongPath(doc, a.actor, [[3, 0, 0]], { frame_start: 1, end_pose: 'sit' });
    const info = actorInfo(new FrameState(doc, r.frame_end + 30), doc, a.actor);
    expect(info.head_top[2] / info.height_m).toBeLessThan(0.8);
  });
});

describe('desk actors: turns and looks', () => {
  it('faceTo turns on the spot to a heading or towards a point', () => {
    const doc = SceneDoc.create({ empty: true });
    const a = createActor(doc, { kind: 'man', location: [1, 1, 0] });
    faceTo(doc, a.actor, { facing_deg: 90, frame: 20, turn_frames: 8 });
    expect(angleDiff(heading(doc, a.actor, 12), 0)).toBeLessThan(1e-3);
    expect(angleDiff(heading(doc, a.actor, 20), 90)).toBeLessThan(1e-3);
    expect(angleDiff(heading(doc, a.actor, 16), 45)).toBeLessThan(20);
    // towards a point to its west
    faceTo(doc, a.actor, { target: [-5, 1, 0], frame: 40 });
    expect(angleDiff(heading(doc, a.actor, 40), -90)).toBeLessThan(1e-3);
    expect(dist(position(doc, a.actor, 40), [1, 1, 0])).toBeLessThan(1e-9);
    expect(code(() => faceTo(doc, a.actor, { frame: 50 }))).toBe('INVALID_PARAMS');
    expect(code(() => faceTo(doc, a.actor, { target: [1, 1, 3], frame: 50 }))).toBe('INVALID_PARAMS');
  });

  it('lookAt turns the head towards the target and back', () => {
    const doc = SceneDoc.create({ empty: true });
    const a = createActor(doc, { kind: 'adult', location: [0, 0, 0] });
    // a ball to the actor's left, in front, at eye height
    const target = ball(doc, 'Ball', [1.2, -1.2, 1.6]);
    // the face's direction: from the head bone's middle through the eyes
    const face = (frame: number) => {
      const fs = new FrameState(doc, frame);
      const info = actorInfo(fs, doc, a.actor);
      const b = fs.boneMatrix(a.actor, 'head')!.matrix;
      const c: Vec3 = [b[12], b[13], b[14]];
      const d = [info.eyes[0] - c[0], info.eyes[1] - c[1]];
      const t = [1.2 - c[0], -1.2 - c[1]];
      return (
        (Math.acos((d[0] * t[0] + d[1] * t[1]) / (Math.hypot(d[0], d[1]) * Math.hypot(t[0], t[1]))) * 180) /
        Math.PI
      );
    };
    const before = face(5);
    const r = lookAt(doc, a.actor, target, { frame: 10, blend_frames: 6 });
    void r;
    expect(face(9)).toBeCloseTo(before, 3);
    expect(face(16)).toBeLessThan(15);
    expect(before).toBeGreaterThan(35);
    lookAt(doc, a.actor, null, { frame: 30, blend_frames: 4 });
    expect(face(34)).toBeCloseTo(before, 1);
    expect(code(() => lookAt(doc, a.actor, a.actor, { frame: 40 }))).toBe('INVALID_PARAMS');
  });
});

describe('desk actors: holds and rides', () => {
  it('a held prop follows the hand, then stays where it was let go', () => {
    const doc = SceneDoc.create({ empty: true });
    const a = createActor(doc, { kind: 'adult', location: [0, 0, 0], facing_deg: 90 });
    const cup = ball(doc, 'Cup', [0.4, -0.4, 0.9], 0.08);
    moveAlongPath(doc, a.actor, [[4, 0, 0]], { frame_start: 20 });
    holdProp(doc, a.actor, cup, { frame: 10, release_frame: 70 });
    const hand = (f: number) => new FrameState(doc, f).boneMatrix(a.actor, 'hand.R')!.matrix;
    const rel = (f: number) => transformPoint3(invert4(hand(f)), position(doc, cup, f));
    // untouched before the grab
    expect(dist(position(doc, cup, 9), [0.4, -0.4, 0.9])).toBeLessThan(1e-9);
    // in the hand from the grab to the release, whatever the hand does
    const inHand = rel(10);
    expect(Math.hypot(...inHand)).toBeLessThan(0.15);
    for (const f of [10, 25, 33.5, 47, 60, 69]) expect(dist(rel(f), inHand), `frame ${f}`).toBeLessThan(1e-4);
    // let go at its visual transform: no jump, then it stays put
    const dropped = position(doc, cup, 70);
    expect(dist(position(doc, cup, 69.99), dropped)).toBeLessThan(0.01);
    expect(dist(position(doc, cup, 90), dropped)).toBeLessThan(1e-9);
    expect(code(() => holdProp(doc, a.actor, a.actor, { frame: 5 }))).toBe('INVALID_PARAMS');
    expect(code(() => holdProp(doc, a.actor, cup, { frame: 50, release_frame: 40 }))).toBe('INVALID_PARAMS');
  });

  it('carries a held prop in front of the body; a later walk moves where it is let go', () => {
    const doc = SceneDoc.create({ empty: true });
    const a = createActor(doc, { kind: 'woman', location: [0, 0, 0], facing_deg: 90 });
    const box = ball(doc, 'Box', [0.35, -0.35, 0.85], 0.16);
    holdProp(doc, a.actor, box, { frame: 10, release_frame: 80 });
    // the walk is keyed after the hold: the release is keyed again where the walk takes the hand
    moveAlongPath(doc, a.actor, [[5, 0, 0]], { frame_start: 20 });
    // carried in front of the body (facing +X), below the chest, through the walk
    for (const f of [10, 40, 60, 79]) {
      const p = position(doc, box, f);
      const i = actorInfo(new FrameState(doc, f), doc, a.actor);
      expect(p[0] - i.chest[0], `frame ${f}`).toBeGreaterThan(0.2);
      expect(Math.abs(p[1] - i.chest[1]), `frame ${f}`).toBeLessThan(0.2);
      expect(p[2], `frame ${f}`).toBeGreaterThan(0.6);
      expect(p[2], `frame ${f}`).toBeLessThan(i.chest[2]);
    }
    // the arms are posed by keyed constraints: on through the hold, blended off after the release
    const arm = doc.getObject(a.actor)!.pose.bones['forearm.R'].constraints ?? [];
    expect(arm.map((c) => c.name)).toEqual(['Hold Box']);
    // let go where the walk took it (no jump), and it stays there
    const dropped = position(doc, box, 80);
    expect(dropped[0]).toBeGreaterThan(2.5);
    expect(dist(position(doc, box, 79.99), dropped)).toBeLessThan(0.01);
    expect(dist(position(doc, box, 100), dropped)).toBeLessThan(1e-9);
    // an unkeyed pose keeps the hold's constraints (and the release where it was)
    applyPose(doc, a.actor, 'wave');
    expect(doc.getObject(a.actor)!.pose.bones['forearm.R'].constraints?.map((c) => c.name)).toEqual([
      'Hold Box',
    ]);
    expect(dist(position(doc, box, 100), dropped)).toBeLessThan(1e-6);
  });

  it("a rider's legs go round the barrel of every mount, a child's too", () => {
    for (const kind of ['horse', 'pony', 'donkey', 'cow'] as ActorKind[])
      for (const riderKind of ['man', 'child'] as ActorKind[]) {
        const doc = SceneDoc.create({ empty: true });
        const m = createActor(doc, { kind, location: [0, 0, 0] });
        const r = createActor(doc, { kind: riderKind, location: [3, 0, 0] });
        mount(doc, r.actor, m.actor, { frame: 1 });
        const fs = new FrameState(doc, 1);
        const barrel = blueprintFor(kind, defaultHeight(kind)).barrel!;
        const toMount = invert4(fs.world(m.actor)!);
        // knees and ankles outside the barrel's elliptical section (the mount's X is across it)
        for (const bone of ['shin.L', 'shin.R', 'foot.L', 'foot.R']) {
          const b = fs.boneMatrix(r.actor, bone)!.matrix;
          const p = transformPoint3(toMount, [b[12], b[13], b[14]]);
          const e = (p[0] / barrel.halfWidth) ** 2 + ((p[2] - barrel.z) / barrel.halfHeight) ** 2;
          expect(e, `${riderKind} on a ${kind}: ${bone}`).toBeGreaterThan(1.15);
        }
        // both feet off the ground, the rider above the saddle
        const info = actorInfo(fs, doc, r.actor);
        expect(info.bounds.min[2], `${riderKind} on a ${kind}`).toBeGreaterThan(0.3);
      }
  });

  it('a rider stays on the saddle while the mount walks, and gets off beside it', () => {
    const doc = SceneDoc.create({ empty: true });
    const horse = createActor(doc, { kind: 'horse', location: [0, 0, 0], facing_deg: 90 });
    const rider = createActor(doc, { kind: 'adult', location: [0, -2, 0] });
    mount(doc, rider.actor, horse.actor, { frame: 5, dismount_frame: 150 });
    const r = moveAlongPath(doc, horse.actor, [[6, 0, 0]], { frame_start: 10 });
    expect(r.frame_end).toBeLessThan(150);
    const seat = (f: number) => {
      const fs = new FrameState(doc, f);
      const hips = fs.boneMatrix(rider.actor, 'hips')!.matrix;
      const saddle = fs.boneMatrix(horse.actor, 'saddle')!.matrix;
      return transformPoint3(invert4(saddle), [hips[12], hips[13], hips[14]]);
    };
    const s0 = seat(5);
    // on the saddle: the hips just above it
    expect(s0[2] ** 2 + s0[0] ** 2).toBeLessThan(0.3 ** 2);
    for (const f of [8, 20, 37.5, 60, 90, r.frame_end, 140])
      expect(dist(seat(f), s0), `frame ${f}`).toBeLessThan(0.01);
    // in the ride pose, feet off the ground; off the horse and standing after the dismount
    expect(actorInfo(new FrameState(doc, 60), doc, rider.actor).bounds.min[2]).toBeGreaterThan(0.3);
    // down on the horse's left (+Y while it faces +X) where the move took it (keyed after the mount)
    const off = actorInfo(new FrameState(doc, 160), doc, rider.actor);
    expect(off.feet[2]).toBeCloseTo(0, 2);
    const saddle = new FrameState(doc, 160).boneMatrix(horse.actor, 'saddle')!.matrix;
    expect(off.feet[1] - saddle[13]).toBeGreaterThan(0.4);
    expect(Math.hypot(off.feet[0] - saddle[12], off.feet[1] - saddle[13])).toBeLessThan(1.2);
    expect(off.facing[0]).toBeCloseTo(1, 2);
    // and after a later turn of the horse, at its new left (facing 180°, +Y: its left is −X)
    faceTo(doc, horse.actor, { facing_deg: 180, frame: 146 });
    const turned = actorInfo(new FrameState(doc, 160), doc, rider.actor);
    const s2 = new FrameState(doc, 160).boneMatrix(horse.actor, 'saddle')!.matrix;
    expect(turned.feet[0] - s2[12]).toBeLessThan(-0.4);
    expect(Math.hypot(turned.feet[0] - s2[12], turned.feet[1] - s2[13])).toBeLessThan(1.2);
    expect(turned.facing[1]).toBeCloseTo(1, 2);
    expect(dist(seat(140), s0)).toBeLessThan(0.01);
    // riders are people and mounts carry saddles
    const dog = createActor(doc, { kind: 'dog', location: [5, 5, 0] });
    expect(code(() => mount(doc, rider.actor, dog.actor, { frame: 200 }))).toBe('INVALID_PARAMS');
    expect(code(() => mount(doc, horse.actor, rider.actor, { frame: 200 }))).toBe('INVALID_PARAMS');
    expect(code(() => mount(doc, rider.actor, rider.actor, { frame: 200 }))).toBe('INVALID_PARAMS');
  });

  it('runs through the operators: move, face, look, hold and mount by name', () => {
    const doc = SceneDoc.create({ empty: true });
    const reg = createOperatorRegistry();
    const ctx: OperatorContext = {
      doc,
      state: createEditorState(),
      origin: doc.origin,
      source: 'test',
      report: () => undefined,
    };
    const add = (kind: string, location: Vec3) =>
      (reg.run(ctx, 'desk.actor_add', { kind, location }).result as { actor: string; name: string }).name;
    const ann = add('woman', [0, 0, 0]);
    const pony = add('pony', [3, 0, 0]);
    ball(doc, 'Apple', [0.3, -0.3, 1]);
    const move = reg.run(ctx, 'desk.actor_move', { actor: ann, points: [[0, -3, 0]], frame_start: 1 });
    expect(move.ok, move.error).toBe(true);
    expect((move.result as { length_m: number }).length_m).toBeCloseTo(3, 6);
    const face = reg.run(ctx, 'desk.actor_face', { actor: ann, target: pony, frame: 120 });
    expect(face.ok, face.error).toBe(true);
    expect(reg.run(ctx, 'desk.actor_look_at', { actor: ann, target: 'Apple', frame: 130 }).ok).toBe(true);
    expect(reg.run(ctx, 'desk.actor_hold', { actor: ann, prop: 'Apple', frame: 140, hand: 'left' }).ok).toBe(
      true,
    );
    const ride = reg.run(ctx, 'desk.actor_mount', { rider: ann, mount: pony, frame: 160 });
    expect(ride.ok, ride.error).toBe(true);
    expect(reg.run(ctx, 'desk.actor_mount', { rider: pony, mount: ann, frame: 170 }).code).toBe(
      'INVALID_PARAMS',
    );
  });
});
