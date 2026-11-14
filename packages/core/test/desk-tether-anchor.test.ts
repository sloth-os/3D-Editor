import { describe, expect, it } from 'vitest';
import { TETHER_DETACH_M, deskTetherDetachments } from '../src/desk/physics';
import { getShots } from '../src/desk/shots';
import { deskScene } from './desk-physics-helpers';

/*
 * A kite's string and what it is tied to. desk.tether_fly keys the string at the anchor point of
 * each frame of the flight (the actor's hand); an anchor moved afterwards (desk.actor_move, a pose, a
 * mount, a prop) leaves the string where it was, tied to nothing: desk.check says so
 * (tether_detached) and the actor operators warn, until the flight is flown again. A flyer is a
 * whole kite or balloon: a part of a store model (its sail) or of an actor is refused.
 */

const FLIGHT = {
  flyer: 'Kite',
  anchor: 'Ada',
  anchor_bone: 'hand.R',
  length_m: 12,
  wind_dir_deg: 90,
  wind_mps: 6,
  frame_start: 1,
  frame_end: 96,
} as const;

/** Ada with a store kite beside her, in a 4 s shot (frames 1–96) framing her. */
function kiteDay() {
  const s = deskScene();
  const ada = s.run('desk.actor_add', { kind: 'adult', name: 'Ada', location: [0, 0, 0] }).actor as string;
  s.run('store.add', { model: 'diamond_kite', location: [0.8, 0, 0.05], name: 'Kite' });
  s.run('desk.shot_add', { name: 'S1', framing: 'wide', angle: 'front', subjects: [ada], duration_s: 4 });
  const shot = getShots(s.doc)[0];
  expect([shot.frame_start, shot.frame_end]).toEqual([1, 96]);
  const detached = () =>
    (s.run('desk.check', {}).issues as { code: string; objects: string[]; message: string }[]).filter(
      (i) => i.code === 'tether_detached',
    );
  return { ...s, ada, detached };
}

describe("a kite's string stays tied to its anchor", () => {
  it('says the string is left behind when the anchor walks away after the flight, until it flies again', () => {
    const t = kiteDay();
    const flown = t.run('desk.tether_fly', FLIGHT);
    const string = flown.string.object as string;
    expect(t.detached()).toEqual([]);
    t.warnings.length = 0;

    // Ada walks 3 m to the side from frame 40: the keyed string stays where her hand was
    t.run('desk.actor_move', { actor: 'Ada', points: [[-3, 0, 0]], frame_start: 40, speed_mps: 1.3 });
    const warned = t.warnings.filter((w) => w.includes('desk.tether_fly'));
    expect(warned).toHaveLength(1);
    // (and after the flight, which leaves the kite where it ends: the scene runs to frame 250)
    expect(warned[0]).toMatch(
      /^The string of 'Kite' \(desk\.tether_fly\) is no longer tied to Ada's hand\.R: it stays where the flight left it \(frames \d+–250, up to \d+\.\d\d m away\)\. Run desk\.tether_fly again/,
    );
    const issues = t.detached();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'error', objects: [string, flown.flyer.object, t.ada] });
    expect(issues[0].message).toMatch(
      /^The string of Kite is not tied to Ada's hand\.R in shot 'S1' \(frames \d+–96, up to \d+\.\d\d m away\): Ada moved after desk\.tether_fly keyed the flight\. Run desk\.tether_fly again/,
    );
    const [d] = deskTetherDetachments(t.doc, [40, 60, 96]);
    expect(d).toMatchObject({ string, anchor: t.ada, bone: 'hand.R' });
    // still tied as she sets off, metres away by the end
    expect(d.frames[0]).toBeGreaterThan(40);
    expect(d.gap).toBeGreaterThan(1);

    // flown again after her walk, the string follows her hand
    t.warnings.length = 0;
    t.run('desk.tether_fly', FLIGHT);
    expect(t.detached()).toEqual([]);
    expect(deskTetherDetachments(t.doc, [1, 40, 60, 80, 96])).toEqual([]);
  });

  it('finds nothing to say when the anchor moved before the flight was keyed, or moves another way', () => {
    const t = kiteDay();
    t.run('desk.actor_move', { actor: 'Ada', points: [[-3, 0, 0]], frame_start: 40, speed_mps: 1.3 });
    t.run('desk.tether_fly', FLIGHT);
    expect(t.detached()).toEqual([]);
    // a kite tied to an empty: another actor's walk leaves it be, and says nothing about it
    t.empty('Post', [2, 1, 1]);
    t.run('desk.actor_add', { kind: 'adult', name: 'Ben', location: [1.5, 0, 0] });
    t.run('store.add', { model: 'diamond_kite', location: [2.5, 1, 0.05], name: 'Kite 2' });
    t.run('desk.tether_fly', { ...FLIGHT, flyer: 'Kite 2', anchor: 'Post', anchor_bone: undefined });
    t.warnings.length = 0;
    t.run('desk.actor_move', { actor: 'Ben', points: [[4, 0, 0]], frame_start: 10, speed_mps: 1.3 });
    expect(t.warnings.filter((w) => w.includes('desk.tether_fly'))).toEqual([]);
    expect(t.detached()).toEqual([]);
  });

  it('warns when a pose or a mount takes the hand away, and checks a held string after the flight', () => {
    const t = kiteDay();
    t.run('desk.tether_fly', { ...FLIGHT, frame_end: 60 });
    t.warnings.length = 0;
    // after the flight the kite holds where it ended ('hold'): Ada waving her right hand pulls away
    t.run('desk.actor_pose', { actor: 'Ada', pose: 'wave', frame: 80, blend_frames: 6 });
    expect(t.warnings.filter((w) => w.includes('no longer tied to'))).toHaveLength(1);
    const [issue] = t.detached();
    expect(issue.message).toMatch(/\(frames? (7[4-9]|8\d|9\d)/);
    expect(TETHER_DETACH_M).toBe(0.05);
  });
});

describe('desk.tether_fly flies a whole kite or balloon', () => {
  it("refuses a part of a store model (its sail) and names the model's root", () => {
    const s = deskScene();
    const kite = s.run('store.add', { model: 'diamond_kite', location: [0.8, 0, 0.05], name: 'Kite' });
    s.empty('Hand', [0, 0, 1.2]);
    const sail = (kite.objects as string[]).find((id) => s.doc.getObject(id)!.name === 'sail')!;
    const before = s.doc.listObjects().length;
    const r = s.reg.run(s.ctx, 'desk.tether_fly', {
      ...FLIGHT,
      flyer: sail,
      anchor: 'Hand',
      anchor_bone: undefined,
    });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(!r.ok && r.error).toMatch(/^'sail' is part of the model 'Kite': fly the model's root \('Kite'\)/);
    expect(s.doc.listObjects()).toHaveLength(before);
    // the model's root flies, sail, spars and tail together
    expect(
      s.run('desk.tether_fly', { ...FLIGHT, flyer: 'Kite', anchor: 'Hand', anchor_bone: undefined }).kind,
    ).toBe('kite');
  });

  it('refuses a body part of an actor', () => {
    const s = deskScene();
    const ada = s.run('desk.actor_add', { kind: 'adult', name: 'Ada', location: [0, 0, 0] }).actor as string;
    s.empty('Hand', [0, 0, 1.2]);
    const part = s.doc.listObjects().find((o) => o.custom_props?.desk_actor === ada && o.id !== ada)!;
    const r = s.reg.run(s.ctx, 'desk.tether_fly', {
      ...FLIGHT,
      flyer: part.id,
      anchor: 'Hand',
      anchor_bone: undefined,
    });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(!r.ok && r.error).toMatch(/is a body part of the actor 'Ada': fly a prop/);
  });
});
