// memory-desk.ts first: it must load before (and without) operators/memory.ts
import { DESK_ACTOR_ESTIMATES, DESK_ACTOR_MAX_OBJECTS } from '../src/operators/memory-desk';
import { describe, expect, it } from 'vitest';
import { createEditorState, createOperatorRegistry, type OperatorContext } from '../src/operators';
import { OperatorError } from '../src/operators/context';
import { SceneDoc } from '../src/doc/scene-doc';
import { FrameState } from '../src/eval/frame-state';
import { createCube } from '../src/mesh/primitives';
import { invert4, multiply4 } from '../src/math/mat4';
import { transformPoint3 } from '../src/math/vec3';
import type { Mat4, Vec3 } from '../src/math/types';
import {
  ACTOR_KINDS,
  ACTOR_PALETTE,
  ANIMAL_POSES,
  BUILT_KINDS,
  HUMANOID_BONES,
  HUMAN_POSES,
  HUMANOID_KINDS,
  OPENPOSE18_KEYPOINTS,
  QUADRUPED_BONES,
  QUADRUPED_KEYPOINTS,
  RIDEABLE_KINDS,
  actorInfo,
  actorKeypoints,
  applyPose,
  createActor,
  defaultActorHeight,
  isActor,
  moveAlongPath,
  type ActorKind,
} from '../src/desk/characters';
import { moveTiming, gaitDef } from '../src/desk/characters/gait';

/*
 * Actors of the director's desk (spec §8): building, poses, measures and keypoints, the operators'
 * validation and the memory estimates. Moves, turns, looks, holds and mounts are in
 * desk-characters-motion.test.ts.
 */

const HUMANS: ActorKind[] = ['adult', 'man', 'woman', 'child', 'toddler', 'elder'];
/** Every built quadruped. */
const ANIMALS: ActorKind[] = BUILT_KINDS.filter((k) => !HUMANOID_KINDS.includes(k));

function scene() {
  return SceneDoc.create({ empty: true });
}

function actor(kind: ActorKind, o: Partial<Parameters<typeof createActor>[1]> = {}) {
  const doc = scene();
  const r = createActor(doc, { kind, location: [0, 0, 0], ...o });
  return { doc, ...r };
}

/** Keypoints by name at a frame. */
function points(doc: SceneDoc, id: string, frame = 1): Record<string, Vec3> {
  const kp = actorKeypoints(new FrameState(doc, frame), doc, id);
  const names = kp.format === 'openpose18' ? OPENPOSE18_KEYPOINTS : QUADRUPED_KEYPOINTS;
  const out: Record<string, Vec3> = {};
  names.forEach((n, i) => {
    const p = kp.points[i];
    if (p) out[n] = p;
  });
  return out;
}

/** World head and tail of a bone at a frame. */
function boneEnds(doc: SceneDoc, id: string, bone: string, frame = 1): { head: Vec3; tail: Vec3 } {
  const fs = new FrameState(doc, frame);
  const b = fs.boneMatrix(id, bone)!;
  const m = b.matrix;
  const head: Vec3 = [m[12], m[13], m[14]];
  return { head, tail: [head[0] + m[4] * b.length, head[1] + m[5] * b.length, head[2] + m[6] * b.length] };
}

/** World vertices' bounds of one part. */
function partBounds(doc: SceneDoc, fs: FrameState, part: string): { min: Vec3; max: Vec3 } {
  const o = doc.getObject(part)!;
  const mesh = doc.getMesh(o.data!)!;
  const w = fs.world(part)!;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const p = transformPoint3(w, [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  return { min, max };
}

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

describe('desk actors: build', () => {
  it('builds every kind but the birds and refuses those with the built list', () => {
    for (const k of ['adult', 'man', 'woman', 'child', 'horse', 'pony', 'dog'] as ActorKind[])
      expect(BUILT_KINDS).toContain(k);
    const unbuilt = ACTOR_KINDS.filter((k) => !BUILT_KINDS.includes(k));
    expect(unbuilt).toEqual(['duck', 'bird']);
    expect(ANIMALS).toHaveLength(11);
    for (const k of unbuilt) {
      const doc = scene();
      let err: unknown;
      try {
        createActor(doc, { kind: k });
      } catch (e) {
        err = e;
      }
      expect(err, k).toBeInstanceOf(OperatorError);
      expect((err as OperatorError).message).toContain('adult');
      // nothing half-built is left behind
      expect(doc.map('objects').size, k).toBe(0);
    }
  });

  it('humanoids have the fixed bones and a BONE-parented part on each but the root', () => {
    for (const kind of HUMANS) {
      const { doc, actor: id, parts } = actor(kind);
      const obj = doc.getObject(id)!;
      expect(isActor(doc, id)).toBe(true);
      const bones = doc.getArmature(obj.data!)!.bones.map((b) => b.name);
      expect([...bones].sort(), kind).toEqual([...HUMANOID_BONES].sort());
      const parented = new Set<string>();
      let tris = 0;
      for (const p of parts) {
        const o = doc.getObject(p)!;
        expect(o.parent).toBe(id);
        expect(o.parent_type).toBe('BONE');
        expect(bones).toContain(o.parent_bone);
        expect(o.custom_props?.desk_actor).toBe(id);
        parented.add(o.parent_bone);
        for (const f of doc.getMesh(o.data!)!.faces) tris += f.length - 2;
      }
      expect([...parented].sort(), kind).toEqual(bones.filter((b) => b !== 'root').sort());
      expect(tris, kind).toBeLessThan(6000);
    }
  });

  it('quadrupeds have the fixed bones; the mounts a saddle, the others none', () => {
    expect([...RIDEABLE_KINDS].sort()).toEqual(['cow', 'donkey', 'horse', 'pony']);
    for (const kind of ANIMALS) {
      const { doc, actor: id, parts } = actor(kind);
      const bones = doc.getArmature(doc.getObject(id)!.data!)!.bones.map((b) => b.name);
      const want = QUADRUPED_BONES.filter((b) => b !== 'saddle' || RIDEABLE_KINDS.includes(kind));
      expect([...bones].sort(), kind).toEqual([...want].sort());
      let tris = 0;
      const parented = new Set<string>();
      for (const p of parts) {
        const o = doc.getObject(p)!;
        expect(o.parent_type, kind).toBe('BONE');
        parented.add(o.parent_bone);
        for (const f of doc.getMesh(o.data!)!.faces) tris += f.length - 2;
      }
      expect([...parented].sort(), kind).toEqual(bones.filter((b) => b !== 'root').sort());
      expect(tris, kind).toBeLessThan(6000);
    }
  });

  it('parts sit on their bones at rest and follow them rigidly in a pose', () => {
    for (const kind of ['adult', 'horse'] as ActorKind[]) {
      const { doc, actor: id, parts } = actor(kind, { location: [1, 2, 0], facing_deg: 30 });
      const rest = new FrameState(doc, 1);
      const rel = new Map<string, Mat4>();
      for (const p of parts) {
        const bone = doc.getObject(p)!.parent_bone;
        const { head, tail } = boneEnds(doc, id, bone);
        const mid = head.map((x, i) => (x + tail[i]) / 2);
        const b = partBounds(doc, rest, p);
        for (let k = 0; k < 3; k++) {
          expect(mid[k], `${kind} ${bone} ${k}`).toBeGreaterThan(b.min[k] - 0.02);
          expect(mid[k], `${kind} ${bone} ${k}`).toBeLessThan(b.max[k] + 0.02);
        }
        rel.set(p, multiply4(invert4(rest.boneMatrix(id, bone)!.matrix), rest.world(p)!));
      }
      applyPose(doc, id, kind === 'adult' ? 'wave' : 'gallop');
      const posed = new FrameState(doc, 1);
      for (const p of parts) {
        const bone = doc.getObject(p)!.parent_bone;
        const r = multiply4(invert4(posed.boneMatrix(id, bone)!.matrix), posed.world(p)!);
        const want = rel.get(p)!;
        for (let i = 0; i < 16; i++) expect(r[i]).toBeCloseTo(want[i], 6);
      }
    }
  });

  it('height_m scales the actor (people to the top of the head, animals at the withers)', () => {
    for (const h of [0.9, 1.5, 1.95]) {
      const { doc, actor: id } = actor('adult', { height_m: h });
      const info = actorInfo(new FrameState(doc, 1), doc, id);
      expect(info.height_m).toBeCloseTo(h, 6);
      expect(Math.abs(info.head_top[2] - h) / h).toBeLessThan(0.01);
      expect(info.bounds.max[2]).toBeCloseTo(info.head_top[2], 2);
    }
    const thigh = (h: number) => {
      const { doc, actor: id } = actor('man', { height_m: h });
      const { head, tail } = boneEnds(doc, id, 'thigh.L');
      return dist(head, tail);
    };
    expect(thigh(1.9) / thigh(1.5)).toBeCloseTo(1.9 / 1.5, 3);
    const size = (h: number) => {
      const { doc, actor: id } = actor('horse', { height_m: h });
      const b = actorInfo(new FrameState(doc, 1), doc, id).bounds;
      return b.max[1] - b.min[1];
    };
    expect(size(1.6) / size(1.2)).toBeCloseTo(1.6 / 1.2, 2);
    // the defaults
    for (const kind of BUILT_KINDS) {
      const { doc, actor: id } = actor(kind);
      expect(actorInfo(new FrameState(doc, 1), doc, id).height_m, kind).toBeCloseTo(
        defaultActorHeight(kind),
        6,
      );
    }
    expect(code(() => actor('adult', { height_m: 0.01 }))).toBe('INVALID_PARAMS');
    expect(code(() => actor('adult', { height_m: Number.NaN }))).toBe('INVALID_PARAMS');
  });

  it('takes the next palette colour, a numbered name, the location and the facing', () => {
    const doc = scene();
    const a = createActor(doc, { kind: 'adult' });
    const b = createActor(doc, { kind: 'adult', location: [3, -2, 0], facing_deg: 90 });
    const c = createActor(doc, { kind: 'dog', color: '#123456', name: 'Rex' });
    expect(doc.getObject(a.actor)!.custom_props?.desk_color).toBe(ACTOR_PALETTE[0]);
    expect(doc.getObject(b.actor)!.custom_props?.desk_color).toBe(ACTOR_PALETTE[1]);
    expect(doc.getObject(c.actor)!.custom_props?.desk_color).toBe('#123456');
    expect(a.name).not.toBe(b.name);
    expect(c.name).toBe('Rex');
    const info = actorInfo(new FrameState(doc, 1), doc, b.actor);
    expect(Math.hypot(info.feet[0] - 3, info.feet[1] + 2)).toBeLessThan(0.1);
    expect(info.feet[2]).toBeCloseTo(0, 3);
    // facing 90° turns the front (−Y) to +X
    expect(info.facing[0]).toBeCloseTo(1, 6);
    expect(info.facing[1]).toBeCloseTo(0, 6);
    // the unkeyed pose: no animation yet
    expect(doc.map('fcurves').size).toBe(0);
  });
});

describe('desk actors: poses', () => {
  it('every pose of every built kind stands on the ground (jump and ride above it)', () => {
    for (const kind of BUILT_KINDS) {
      const poses: readonly string[] = HUMANS.includes(kind) ? HUMAN_POSES : ANIMAL_POSES;
      for (const pose of poses) {
        const { doc, actor: id } = actor(kind, { pose });
        const info = actorInfo(new FrameState(doc, 1), doc, id);
        const h = info.height_m;
        if (pose === 'jump' || pose === 'ride')
          expect(info.bounds.min[2], `${kind} ${pose}`).toBeGreaterThan(0.05 * h);
        else {
          expect(info.bounds.min[2], `${kind} ${pose}`).toBeGreaterThan(-0.005);
          expect(info.bounds.min[2], `${kind} ${pose}`).toBeLessThan(0.01);
        }
        for (const v of [...info.eyes, ...info.head_top, ...info.chest])
          expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('every quadruped stands on its hooves or paws (nothing of the legs below the soles)', () => {
    for (const kind of ANIMALS) {
      const { doc, actor: id } = actor(kind);
      const info = actorInfo(new FrameState(doc, 1), doc, id);
      const kp = points(doc, id);
      for (const n of ['l_front_paw', 'r_front_paw', 'l_back_paw', 'r_back_paw'])
        expect(kp[n][2], `${kind} ${n}`).toBeLessThan(0.002 * info.height_m + 1e-4);
      expect(info.bounds.min[2], kind).toBeGreaterThan(-1e-4);
    }
  });

  it("keeps rideo's pose heights (stand, sit, crouch, kneel, lie)", () => {
    const share = (pose: string) => {
      const { doc, actor: id } = actor('adult', { pose });
      const info = actorInfo(new FrameState(doc, 1), doc, id);
      return info.head_top[2] / info.height_m;
    };
    expect(share('stand')).toBeCloseTo(1, 2);
    expect(Math.abs(share('sit') - 0.72)).toBeLessThan(0.06);
    expect(Math.abs(share('crouch') - 0.62)).toBeLessThan(0.09);
    expect(Math.abs(share('kneel') - 0.74)).toBeLessThan(0.05);
    expect(share('lie')).toBeLessThan(0.22);
  });

  it('humanoid poses move the bones they name', () => {
    const at = (pose: string) => {
      const { doc, actor: id } = actor('adult', { pose });
      return points(doc, id);
    };
    const stand = at('stand');
    // the right arm waves above the head, points and reaches forward at shoulder height
    const wave = at('wave');
    expect(wave.r_wrist[2]).toBeGreaterThan(wave.nose[2]);
    expect(wave.l_wrist[2]).toBeCloseTo(stand.l_wrist[2], 2);
    for (const pose of ['point', 'reach']) {
      const p = at(pose);
      expect(p.r_wrist[1], pose).toBeLessThan(stand.r_shoulder[1] - 0.4);
      expect(Math.abs(p.r_wrist[2] - p.r_shoulder[2]), pose).toBeLessThan(0.2);
    }
    // arms crossed in front of the chest; hands on the hips; a carry in front
    const crossed = at('arms_crossed');
    expect(crossed.r_wrist[0]).toBeGreaterThan(crossed.l_wrist[0]);
    expect(Math.abs(crossed.r_wrist[0])).toBeLessThan(0.15);
    expect(crossed.r_wrist[1]).toBeLessThan(-0.08);
    const hips = at('hands_on_hips');
    for (const s of ['r', 'l']) {
      expect(Math.abs(hips[`${s}_wrist`][2] - hips[`${s}_hip`][2]), s).toBeLessThan(0.18);
      expect(Math.abs(hips[`${s}_wrist`][0]), s).toBeGreaterThan(Math.abs(hips[`${s}_hip`][0]));
    }
    const carry = at('carry');
    expect(carry.r_wrist[1]).toBeLessThan(-0.25);
    expect(carry.l_wrist[1]).toBeLessThan(-0.25);
    // sitting: the thighs level; a kick: the right foot up in front; looking up: the nose rises
    const sit = at('sit');
    expect(Math.abs(sit.r_hip[2] - sit.r_knee[2])).toBeLessThan(0.08);
    const kick = at('kick');
    expect(kick.r_ankle[2]).toBeGreaterThan(0.3);
    expect(kick.r_ankle[1]).toBeLessThan(-0.4);
    expect(kick.l_ankle[2]).toBeLessThan(0.12);
    const up = at('look_up');
    expect(up.nose[2] - up.r_eye[2]).toBeGreaterThan(stand.nose[2] - stand.r_eye[2]);
    expect(at('sit_ground').r_hip[2]).toBeLessThan(0.25 * 1.7);
    // lying on the back as rideo draws it: the head behind the mark (+Y, the facing is −Y), the
    // feet towards the facing, the face up
    const lie = at('lie');
    expect(lie.nose[1]).toBeGreaterThan(0.4);
    expect(lie.r_ankle[1]).toBeLessThan(-0.6);
    expect(lie.nose[2]).toBeGreaterThan(lie.r_ear[2] + 0.06);
    expect(Math.abs(lie.r_hip[2] - lie.r_ankle[2])).toBeLessThan(0.05);
  });

  it('quadruped poses: grazing, looking up, sitting and lying', () => {
    for (const kind of ['horse', 'dog'] as ActorKind[]) {
      const pose = (p: string) => {
        const { doc, actor: id } = actor(kind, { pose: p });
        return { kp: points(doc, id), info: actorInfo(new FrameState(doc, 1), doc, id) };
      };
      const stand = pose('stand');
      const h = stand.info.height_m;
      // the muzzle down to the grass (a dog to its bowl)
      expect(pose('eat').kp.nose[2], kind).toBeLessThan(0.25 * h);
      expect(pose('look_up').kp.nose[2], kind).toBeGreaterThan(stand.kp.nose[2] + 0.1 * h);
      // sitting on the rump with the front paws on the ground
      const sit = pose('sit');
      expect(sit.kp.l_front_paw[2], kind).toBeLessThan(0.03 * h);
      expect(sit.kp.tail_root[2], kind).toBeLessThan(0.6 * stand.kp.tail_root[2]);
      expect(sit.kp.neck[2], kind).toBeGreaterThan(sit.kp.tail_root[2]);
      // lying: the chest low
      expect(pose('lie').info.chest[2], kind).toBeLessThan(0.6 * stand.info.chest[2]);
      // trotting and galloping: a hoof or paw off the ground
      for (const g of ['trot', 'gallop']) {
        const kp = pose(g).kp;
        const paws = ['l_front_paw', 'r_front_paw', 'l_back_paw', 'r_back_paw'].map((n) => kp[n][2]);
        expect(Math.max(...paws), `${kind} ${g}`).toBeGreaterThan(0.05 * h);
      }
    }
  });

  it('keys a pose blended in and held; refuses poses of the other family', () => {
    const { doc, actor: id } = actor('adult');
    const stand = points(doc, id);
    applyPose(doc, id, 'wave', { frame: 20, blend_frames: 6, hold_frames: 10 });
    expect(doc.map('fcurves').size).toBeGreaterThan(0);
    // still standing before the blend, waving from the frame through the hold
    expect(points(doc, id, 10).r_wrist[2]).toBeCloseTo(stand.r_wrist[2], 4);
    const waving = points(doc, id, 20).r_wrist;
    expect(waving[2]).toBeGreaterThan(stand.nose[2]);
    expect(dist(points(doc, id, 30).r_wrist, waving)).toBeLessThan(1e-4);
    expect(points(doc, id, 17).r_wrist[2]).toBeGreaterThan(stand.r_wrist[2] + 0.05);
    expect(points(doc, id, 17).r_wrist[2]).toBeLessThan(waving[2] - 0.05);
    expect(code(() => applyPose(doc, id, 'gallop', { frame: 40 }))).toBe('INVALID_PARAMS');
    expect(code(() => applyPose(doc, id, 'dance'))).toBe('INVALID_PARAMS');
    const horse = createActor(doc, { kind: 'horse', location: [5, 0, 0] });
    expect(code(() => applyPose(doc, horse.actor, 'wave'))).toBe('INVALID_PARAMS');
  });
});

describe('desk actors: measures and keypoints', () => {
  it('actorInfo: eyes and the top of the head within 3% of the expected heights', () => {
    const want: Partial<Record<ActorKind, number>> = { adult: 0.933, man: 0.933, woman: 0.933, child: 0.91 };
    for (const [kind, eyes] of Object.entries(want) as [ActorKind, number][]) {
      const { doc, actor: id } = actor(kind);
      const info = actorInfo(new FrameState(doc, 1), doc, id);
      const h = info.height_m;
      expect(Math.abs(info.head_top[2] - h) / h, kind).toBeLessThan(0.03);
      expect(Math.abs(info.eyes[2] / h - eyes), kind).toBeLessThan(0.03);
      // eyes in front of the head's centre line, the chest between the hips and the eyes
      expect(info.eyes[1], kind).toBeLessThan(-0.05);
      expect(info.chest[2], kind).toBeGreaterThan(0.55 * h);
      expect(info.chest[2], kind).toBeLessThan(info.eyes[2]);
      for (let k = 0; k < 3; k++) {
        expect(info.head_top[k]).toBeLessThanOrEqual(info.bounds.max[k] + 1e-6);
        expect(info.feet[k]).toBeGreaterThanOrEqual(info.bounds.min[k] - 1e-6);
      }
    }
  });

  it('actorInfo follows the object: scale, location and facing', () => {
    const { doc, actor: id } = actor('woman', { location: [2, 1, 0], facing_deg: -90 });
    doc.updateObject(id, { scale: [2, 2, 2] });
    const info = actorInfo(new FrameState(doc, 1), doc, id);
    expect(info.height_m).toBeCloseTo(2 * 1.64, 6);
    expect(info.head_top[2]).toBeCloseTo(2 * 1.64, 1);
    expect(info.facing[0]).toBeCloseTo(-1, 6);
    expect(Math.hypot(info.feet[0] - 2, info.feet[1] - 1)).toBeLessThan(0.2);
  });

  it('OpenPose-18 keypoints: the character’s right is its right, joints at the bones', () => {
    const { doc, actor: id } = actor('adult');
    const kp = actorKeypoints(new FrameState(doc, 1), doc, id);
    expect(kp.format).toBe('openpose18');
    expect(kp.points).toHaveLength(OPENPOSE18_KEYPOINTS.length);
    const p = points(doc, id);
    // facing −Y, the character's right is −X
    for (const n of ['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle', 'eye', 'ear']) {
      expect(p[`r_${n}`][0], n).toBeLessThan(0);
      expect(p[`l_${n}`][0], n).toBeGreaterThan(0);
    }
    expect(dist(p.r_knee, boneEnds(doc, id, 'shin.R').head)).toBeLessThan(1e-6);
    expect(dist(p.l_elbow, boneEnds(doc, id, 'forearm.L').head)).toBeLessThan(1e-6);
    expect(dist(p.r_wrist, boneEnds(doc, id, 'hand.R').head)).toBeLessThan(1e-6);
    expect(p.nose[1]).toBeLessThan(p.neck[1]);
    expect(p.r_eye[2]).toBeGreaterThan(p.nose[2]);
    expect(p.neck[2]).toBeGreaterThan(p.r_shoulder[2] - 0.1);
    expect(p.r_ankle[2]).toBeLessThan(0.12);
    expect(p.r_hip[2]).toBeGreaterThan(0.45 * 1.7);
    // a turned actor's keypoints turn with it: facing +X, the right is −Y
    const t = actor('adult', { facing_deg: 90 });
    const q = points(t.doc, t.actor);
    expect(q.r_shoulder[1]).toBeLessThan(-0.1);
    expect(q.l_shoulder[1]).toBeGreaterThan(0.1);
    expect(q.nose[0]).toBeGreaterThan(q.neck[0]);
  });

  it('quadruped keypoints: 17 points, left on the left, paws on the ground', () => {
    const { doc, actor: id } = actor('horse');
    const kp = actorKeypoints(new FrameState(doc, 1), doc, id);
    expect(kp.format).toBe('quadruped');
    expect(kp.points).toHaveLength(QUADRUPED_KEYPOINTS.length);
    expect(kp.points.every((x) => x !== null)).toBe(true);
    const p = points(doc, id);
    for (const n of ['eye', 'shoulder', 'elbow', 'front_paw', 'hip', 'knee', 'back_paw']) {
      expect(p[`l_${n}`][0], n).toBeGreaterThan(0);
      expect(p[`r_${n}`][0], n).toBeLessThan(0);
    }
    for (const n of ['l_front_paw', 'r_front_paw', 'l_back_paw', 'r_back_paw'])
      expect(p[n][2], n).toBeLessThan(0.02);
    expect(p.nose[1]).toBeLessThan(p.neck[1]);
    expect(p.tail_root[1]).toBeGreaterThan(0);
    expect(p.l_elbow[2]).toBeLessThan(p.l_shoulder[2]);
    expect(p.l_front_paw[1]).toBeLessThan(p.l_back_paw[1]);
  });

  it('measures refuse what is not an actor', () => {
    const doc = scene();
    const cube = doc.addObject({
      type: 'MESH',
      name: 'Cube',
      data: doc.addMesh('Cube', createCube({ size: 1 })),
    });
    expect(isActor(doc, cube)).toBe(false);
    expect(code(() => actorInfo(new FrameState(doc, 1), doc, cube))).toBe('FAILED');
    expect(code(() => actorKeypoints(new FrameState(doc, 1), doc, 'nope'))).toBe('NOT_FOUND');
  });
});

describe('desk actors: gait timing', () => {
  it('walks about 1.8 steps a second at 1.3 m/s and runs about 2.8 at 3.5 m/s', () => {
    const walk = moveTiming('humanoid', 1.7, 20, 0, { asked: 'walk', speed: 1.3, total: null });
    const run = moveTiming('humanoid', 1.7, 20, 0, { asked: 'run', speed: 3.5, total: null });
    expect((2 * walk.v) / walk.S).toBeGreaterThan(1.7);
    expect((2 * walk.v) / walk.S).toBeLessThan(1.95);
    expect((2 * run.v) / run.S).toBeGreaterThan(2.6);
    expect((2 * run.v) / run.S).toBeLessThan(3.0);
    // stride = speed / cadence, longer when faster; auto picks the gait from the speed
    const slow = moveTiming('humanoid', 1.7, 20, 0, { asked: 'walk', speed: 0.9, total: null });
    expect(slow.S).toBeLessThan(walk.S);
    expect(moveTiming('humanoid', 1.7, 20, 0, { asked: null, speed: 4, total: null }).gait).toBe('run');
    expect(moveTiming('quadruped', 1.6, 20, 0, { asked: null, speed: 1.5, total: null }).gait).toBe('walk');
    expect(moveTiming('quadruped', 1.6, 20, 0, { asked: null, speed: 4, total: null }).gait).toBe('trot');
    expect(moveTiming('quadruped', 1.6, 20, 0, { asked: null, speed: 9, total: null }).gait).toBe('gallop');
    // arriving at a given time: the ramps are paid for
    const t = moveTiming('humanoid', 1.7, 10, 0, { asked: null, total: 8 });
    expect(10 / t.v + t.ta).toBeCloseTo(8, 3);
    // a sharp first turn is made on the spot
    expect(moveTiming('humanoid', 1.7, 10, Math.PI / 2, { asked: null, total: null }).turnT).toBeGreaterThan(
      0,
    );
    expect(gaitDef('humanoid', 'trot')).toBeNull();
  });
});

describe('desk actors: operators and estimates', () => {
  function setup() {
    const doc = scene();
    const reg = createOperatorRegistry();
    const ctx: OperatorContext = {
      doc,
      state: createEditorState(),
      origin: doc.origin,
      source: 'test',
      report: () => undefined,
    };
    return { doc, reg, ctx };
  }
  const keyCount = (doc: SceneDoc) => {
    let n = 0;
    for (const v of doc.map('fcurves').values())
      n += ((v as { keyframes?: unknown[] }).keyframes ?? []).length;
    return n;
  };

  it('desk.actor_add stands the actor at the 3D cursor and selects it', () => {
    const { doc, reg, ctx } = setup();
    ctx.state.cursorLocation = [4, 5, 0];
    const r = reg.run(ctx, 'desk.actor_add', { kind: 'child' });
    expect(r.ok).toBe(true);
    const res = r.result as { actor: string; parts: string[]; name: string };
    expect(res.parts.length).toBeGreaterThan(10);
    expect(ctx.state.activeId).toBe(res.actor);
    expect(ctx.state.selectedIds).toEqual([res.actor]);
    const info = actorInfo(new FrameState(doc, 1), doc, res.actor);
    expect(Math.hypot(info.feet[0] - 4, info.feet[1] - 5)).toBeLessThan(0.1);
    // an unbuilt kind and a non-actor are refused with a clear message
    const duck = reg.run(ctx, 'desk.actor_add', { kind: 'duck' });
    expect(duck.ok).toBe(false);
    expect(duck.error).toMatch(/adult/);
    const cube = doc.addObject({
      type: 'MESH',
      name: 'Cube',
      data: doc.addMesh('Cube', createCube({ size: 1 })),
    });
    const pose = reg.run(ctx, 'desk.actor_pose', { actor: cube, pose: 'wave', frame: 5 });
    expect(pose.ok).toBe(false);
    expect(pose.code).toBe('INVALID_PARAMS');
    expect(pose.error).toMatch(/not an actor/);
    // a part names its actor
    expect(reg.run(ctx, 'desk.actor_pose', { actor: res.parts[0], pose: 'wave', frame: 5 }).ok).toBe(true);
  });

  it('estimates cover what the operators add and key', () => {
    const { doc, reg, ctx } = setup();
    const run = (id: string, params: Record<string, unknown>) => {
      const parsed = reg.parseParams(id, params) as Record<string, unknown>;
      const est = DESK_ACTOR_ESTIMATES[id](ctx, parsed);
      const keys = keyCount(doc);
      const objects = doc.map('objects').size;
      const r = reg.run(ctx, id, params);
      expect(r.ok, `${id} ${r.error ?? ''}`).toBe(true);
      expect(keyCount(doc) - keys, id).toBeLessThanOrEqual(est?.keyframes ?? 0);
      expect(doc.map('objects').size - objects, id).toBeLessThanOrEqual(est?.objects ?? 0);
      return { r, est, keys: keyCount(doc) - keys };
    };
    const adult = (
      run('desk.actor_add', { kind: 'adult', location: [0, 0, 0] }).r.result as { actor: string }
    ).actor;
    const horse = (
      run('desk.actor_add', { kind: 'horse', location: [4, 0, 0] }).r.result as { actor: string }
    ).actor;
    const dog = (run('desk.actor_add', { kind: 'dog', location: [-4, 0, 0] }).r.result as { actor: string })
      .actor;
    expect(DESK_ACTOR_ESTIMATES['desk.actor_add'](ctx, { kind: 'adult' })!.objects).toBe(
      DESK_ACTOR_MAX_OBJECTS,
    );
    run('desk.actor_pose', { actor: adult, pose: 'sit', frame: 10, hold_frames: 5 });
    run('desk.actor_face', { actor: adult, facing_deg: 90, frame: 30 });
    const walk = run('desk.actor_move', { actor: adult, points: [[6, 0, 0]], frame_start: 40 });
    // the bound is not wildly above the keys
    expect(walk.est!.keyframes!).toBeLessThan(4 * walk.keys);
    run('desk.actor_move', {
      actor: dog,
      points: [[-4, -10, 0]],
      frame_start: 1,
      gait: 'gallop',
      frame_end: 30,
    });
    run('desk.actor_move', {
      actor: horse,
      points: [[4, -12, 0]],
      frame_start: 1,
      gait: 'trot',
      speed_mps: 6,
    });
    const cube = doc.addObject({
      type: 'MESH',
      name: 'Ball',
      data: doc.addMesh('Ball', createCube({ size: 0.2 })),
    });
    run('desk.actor_look_at', { actor: adult, target: cube, frame: 120 });
    run('desk.actor_look_at', { actor: adult, target: horse, frame: 140 });
    run('desk.actor_hold', { actor: adult, prop: cube, frame: 150, release_frame: 170 });
    run('desk.actor_mount', { rider: adult, mount: horse, frame: 200, dismount_frame: 260 });
    // a quadruped stepping round half a turn, and a timed path cut at a U-turn (two moves, a turn
    // on the spot between them)
    run('desk.actor_face', { actor: horse, facing_deg: -90, frame: 330, turn_frames: 40 });
    run('desk.actor_move', {
      actor: dog,
      points: [
        [-4, -14, 0],
        [-4, -10.5, 0],
      ],
      frame_start: 340,
      frame_end: 520,
    });
    // sideways without facing the path: short steps, many of them
    run('desk.actor_move', { actor: dog, points: [[1, -10.5, 0]], frame_start: 560, face_path: false });
    // a longer path keys more cycles
    const est = (x: number) =>
      DESK_ACTOR_ESTIMATES['desk.actor_move'](ctx, { actor: dog, points: [[x, 0, 0]], frame_start: 400 })!
        .keyframes!;
    expect(est(40)).toBeGreaterThan(est(5));
  });
});

describe('desk actors: review regressions', () => {
  const heightOf = (doc: SceneDoc, id: string) => Number(doc.getObject(id)!.custom_props!.desk_height_m);

  it('grazing keeps the muzzle ahead of the front feet and pointing down, for every quadruped', () => {
    for (const kind of ANIMALS) {
      const { doc, actor: id } = actor(kind, { pose: 'eat' });
      const h = heightOf(doc, id);
      const kp = points(doc, id);
      // facing −Y: the nose in front of both front paws, not folded back between the legs
      for (const paw of ['l_front_paw', 'r_front_paw'])
        expect(kp[paw][1] - kp.nose[1], `${kind} ${paw}`).toBeGreaterThan(0.08 * h);
      // the muzzle (head to nose) points down and forward
      const head = boneEnds(doc, id, 'head').head;
      expect(head[2] - kp.nose[2], kind).toBeGreaterThan(0);
      expect(head[1] - kp.nose[1], kind).toBeGreaterThan(0);
    }
  });

  it('lying animals rest on their barrel, within 3% of their height of the ground', () => {
    for (const kind of ANIMALS) {
      const { doc, actor: id, parts } = actor(kind, { pose: 'lie' });
      const h = heightOf(doc, id);
      const fs = new FrameState(doc, 1);
      let barrel = Infinity;
      let lowest = Infinity;
      for (const p of parts) {
        const b = partBounds(doc, fs, p);
        lowest = Math.min(lowest, b.min[2]);
        if (['hips', 'spine', 'chest'].includes(doc.getObject(p)!.parent_bone ?? ''))
          barrel = Math.min(barrel, b.min[2]);
      }
      expect(lowest, kind).toBeGreaterThan(-0.005);
      expect(barrel, kind).toBeLessThan(0.03 * h + 0.005);
    }
  });

  it('a pose keys only the channels it changes', () => {
    const { doc, actor: id } = actor('adult');
    const curves = () =>
      [...doc.map('fcurves').values()].filter((v) => (v as { target_id?: string }).target_id === id).length;
    applyPose(doc, id, 'wave', { frame: 10 });
    const wave = curves();
    expect(wave).toBeGreaterThan(0);
    // the right arm only: no F-curve holding one value on every other channel of the body
    expect(wave).toBeLessThanOrEqual(12);
    applyPose(doc, id, 'stand', { frame: 30 });
    expect(curves()).toBe(wave);
    // and the pose still comes and goes
    expect(points(doc, id, 10).r_wrist[2]).toBeGreaterThan(points(doc, id, 1).nose[2]);
    expect(dist(points(doc, id, 30).r_wrist, points(doc, id, 1).r_wrist)).toBeLessThan(1e-4);
  });

  it('an actor named by one of its parts is estimated as the actor', () => {
    const doc = scene();
    const reg = createOperatorRegistry();
    const ctx: OperatorContext = {
      doc,
      state: createEditorState(),
      origin: doc.origin,
      source: 'test',
      report: () => undefined,
    };
    const adult = createActor(doc, { kind: 'adult', location: [0, 0, 0] });
    const horse = createActor(doc, { kind: 'horse', location: [3, 0, 0] });
    const ball = doc.addObject({
      type: 'MESH',
      name: 'Ball',
      data: doc.addMesh('Ball', createCube({ size: 0.2 })),
    });
    // keys to copy again
    moveAlongPath(doc, adult.actor, [[0, -2, 0]], { frame_start: 1 });
    const cases: [string, Record<string, unknown>, string][] = [
      ['desk.actor_pose', { pose: 'wave', frame: 90 }, 'actor'],
      ['desk.actor_move', { points: [[2, -2, 0]], frame_start: 100 }, 'actor'],
      ['desk.actor_face', { facing_deg: 120, frame: 150 }, 'actor'],
      ['desk.actor_look_at', { target: ball, frame: 160 }, 'actor'],
      ['desk.actor_hold', { prop: ball, frame: 170 }, 'actor'],
      ['desk.actor_mount', { mount: horse.actor, frame: 200 }, 'rider'],
    ];
    const part = adult.parts.find((p) => doc.getObject(p)!.parent_bone === 'forearm.R')!;
    for (const [op, params, key] of cases) {
      const est = (ref: string) =>
        DESK_ACTOR_ESTIMATES[op](
          ctx,
          reg.parseParams(op, { ...params, [key]: ref }) as Record<string, unknown>,
        );
      expect(est(part), op).toEqual(est(adult.actor));
    }
  });
});
