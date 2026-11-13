import { describe, expect, it } from 'vitest';
import type { Mat4, Vec3 } from '../src/math/types';
import { deskTetherSeed, deskWindModel } from '../src/desk/physics';
import { sceneSampler } from '../src/desk/physics/common';
import { channelsAt, deskScene, dist, kiteMesh, originOf, transformPoint } from './desk-physics-helpers';

/*
 * desk.tether_fly (spec §4, phase 2): a kite or a balloon on a string from an anchor, keyed on every
 * frame: never farther from the anchor than the string, never under the ground, a kite 35–60° above
 * the horizon in a steady wind and dipping in the lulls, the same flight for the same seed; a string
 * object from the anchor to the bridle and a damped tail of 4–6 segments.
 */

const KITE_CORNERS: Vec3[] = [
  [0, 0, 0.6],
  [0.4, 0, 0],
  [0, 0, -0.4],
  [-0.4, 0, 0],
];

function kiteScene(opts: { name?: string; kite?: Vec3; hand?: Vec3 } = {}) {
  const s = deskScene();
  const kite = s.doc.addObject({
    type: 'MESH',
    name: opts.name ?? 'Kite',
    data: s.mesh('kite', kiteMesh),
    location: opts.kite ?? [0.5, 0, 1.3],
  });
  const hand = s.empty('Hand', opts.hand ?? [0, 0, 1.2]);
  return { ...s, kite, hand };
}

/** The world matrices of `ids` at each of `frames` (transforms only: the keys are what is tested). */
function flight(doc: ReturnType<typeof deskScene>['doc'], ids: string[], frames: number[]) {
  const sampler = sceneSampler(doc);
  return frames.map((f) => {
    const state = sampler.at(f);
    return new Map<string, Mat4>(ids.map((id) => [id, state.world(id)!]));
  });
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

const FLY = { flyer: 'Kite', anchor: 'Hand', length_m: 20, wind_dir_deg: 90, wind_mps: 6 } as const;

describe('desk.tether_fly', () => {
  it('flies a kite on a taut string: never longer than it, never under the ground, above the anchor', () => {
    const t = kiteScene();
    // 50 s: the 8 s launch, then at least one lull (they come every 15–30 s)
    const r = t.run('desk.tether_fly', { ...FLY, frame_start: 1, frame_end: 1200 });
    expect(r.kind).toBe('kite');
    expect(r.tail_objects).toHaveLength(5);
    const tail = r.tail_objects.map((o: { object: string }) => o.object);
    const frames = range(1, 1200);
    const states = flight(t.doc, [t.kite, t.hand, ...tail], frames);
    const elevations: number[] = [];
    const lengths: number[] = [];
    states.forEach((m, i) => {
      const k = m.get(t.kite)!;
      const a = originOf(m.get(t.hand)!);
      const d = dist(originOf(k), a);
      expect(d, `frame ${frames[i]}`).toBeLessThanOrEqual(20 + 1e-6);
      for (const c of KITE_CORNERS) expect(transformPoint(k, c)[2]).toBeGreaterThan(-1e-6);
      for (const id of tail) expect(originOf(m.get(id)!)[2]).toBeGreaterThan(0);
      if (frames[i] > 240) {
        elevations.push((Math.asin((originOf(k)[2] - a[2]) / d) * 180) / Math.PI);
        lengths.push(d);
      }
    });
    // after the launch: taut (slack only in the lulls), 35–60° up, dipping in the lulls
    const median = (v: number[]) => [...v].sort((x, y) => x - y)[v.length >> 1];
    expect(median(lengths)).toBeGreaterThan(19.9);
    expect(Math.min(...elevations)).toBeGreaterThan(15);
    const mean = elevations.reduce((x, y) => x + y, 0) / elevations.length;
    expect(mean).toBeGreaterThan(35);
    expect(mean).toBeLessThan(60);
    expect(Math.max(...elevations)).toBeLessThan(60);
    expect(Math.min(...elevations)).toBeLessThan(median(elevations) - 3);
    expect(r.mean_elevation_deg).toBeGreaterThan(35);
    expect(r.mean_elevation_deg).toBeLessThan(60);
  });

  it('rises to the end of the string over launch_frames', () => {
    const t = kiteScene();
    t.run('desk.tether_fly', { ...FLY, frame_start: 1, frame_end: 200, launch_frames: 96 });
    const states = flight(t.doc, [t.kite, t.hand], [1, 48, 97, 140]);
    const len = states.map((m) => dist(originOf(m.get(t.kite)!), originOf(m.get(t.hand)!)));
    expect(len[0]).toBeLessThan(1);
    expect(len[1]).toBeLessThan(15);
    expect(len[2]).toBeGreaterThan(19.5);
    expect(len[3]).toBeGreaterThan(19.5);
  });

  it('faces the anchor, nose up, with a string object joining the hand and the bridle', () => {
    const t = kiteScene();
    const r = t.run('desk.tether_fly', { ...FLY, frame_start: 10, frame_end: 300 });
    const string = t.doc.getObject(r.string.object)!;
    expect(string.custom_props?.desk_role).toBe('string');
    for (const f of [60, 150, 299]) {
      const [m] = flight(t.doc, [t.kite, t.hand, string.id], [f]);
      const k = m.get(t.kite)!;
      const a = originOf(m.get(t.hand)!);
      const toAnchor = originOf(k).map((v, i) => a[i] - v) as Vec3;
      const l = Math.hypot(...toAnchor);
      // its front (−Y) toward the anchor, its top (+Z) upward
      expect(-(k[4] * toAnchor[0] + k[5] * toAnchor[1] + k[6] * toAnchor[2]) / l).toBeGreaterThan(0.99);
      expect(k[10]).toBeGreaterThan(0);
      // the string: from the hand (its origin) along its local +Z to the kite's bridle
      const sm = m.get(string.id)!;
      expect(dist(originOf(sm), a)).toBeLessThan(1e-6);
      expect(dist(transformPoint(sm, [0, 0, 1]), originOf(k))).toBeLessThan(1e-3);
    }
    // the string and the tail are hidden before the flight, the kite stays where it was
    const before = 5;
    expect(channelsAt(t.doc, string.id, before).scale[2]).toBeLessThan(1e-3);
    for (const o of r.tail_objects) expect(channelsAt(t.doc, o.object, before).scale[0]).toBeLessThan(1e-3);
    expect(channelsAt(t.doc, r.tail_objects[0].object, 10).scale[0]).toBe(1);
    const [m] = flight(t.doc, [t.kite], [before]);
    expect(originOf(m.get(t.kite)!)).toEqual([0.5, 0, 1.3]);
  });

  it('flies the same flight for the same seed and another for another seed', () => {
    const keys = (seed?: number) => {
      const t = kiteScene();
      t.run('desk.tether_fly', {
        ...FLY,
        frame_start: 1,
        frame_end: 240,
        ...(seed === undefined ? {} : { seed }),
      });
      return t.doc
        .listFCurves()
        .filter((fc) => fc.target_id === t.kite)
        .map((fc) => fc.keyframes.map((k) => k.value));
    };
    expect(keys(7)).toEqual(keys(7));
    expect(keys(7)).not.toEqual(keys(8));
    // without a seed: the one from the flyer's name
    expect(keys()).toEqual(keys(deskTetherSeed('Kite')));
  });

  it('blows a wind within 45–150% of its speed about the direction, the same for a seed', () => {
    const w = deskWindModel(3, 8, 90);
    const again = deskWindModel(3, 8, 90);
    for (let t = 0; t < 120; t += 0.37) {
      const v = w(t);
      const speed = Math.hypot(v[0], v[1], v[2]);
      expect(speed).toBeGreaterThanOrEqual(0.45 * 8 - 1e-9);
      expect(speed).toBeLessThanOrEqual(1.5 * 8 + 1e-9);
      // toward +X, swinging a few degrees
      expect(Math.abs(Math.atan2(v[1], v[0]))).toBeLessThan((10 * Math.PI) / 180);
      expect(again(t)).toEqual(v);
    }
  });

  it('lets a kite without wind lie on the ground, and a balloon rise without a tail', () => {
    const calm = kiteScene();
    calm.run('desk.tether_fly', { ...FLY, wind_mps: 0, frame_start: 1, frame_end: 200 });
    const [m] = flight(calm.doc, [calm.kite], [200]);
    const k = m.get(calm.kite)!;
    const low = Math.min(...KITE_CORNERS.map((c) => transformPoint(k, c)[2]));
    expect(low).toBeGreaterThan(-1e-6);
    expect(low).toBeLessThan(0.01);

    const b = deskScene();
    const balloon = b.ball('Red Balloon', [0.3, 0, 1.5], 0.3);
    const hand = b.empty('Hand', [0, 0, 1.2]);
    const r = b.run('desk.tether_fly', {
      flyer: 'Red Balloon',
      anchor: 'Hand',
      length_m: 3,
      wind_dir_deg: 0,
      wind_mps: 1,
      frame_start: 1,
      frame_end: 240,
    });
    expect(r.kind).toBe('balloon');
    expect(r.tail).toBeNull();
    expect(b.warnings).toContain('balloons fly without a tail');
    const [end] = flight(b.doc, [balloon, hand], [240]);
    const top = originOf(end.get(balloon)!);
    expect(top[2] - 1.2).toBeGreaterThan(2.5);
    expect(dist(top, originOf(end.get(hand)!))).toBeLessThanOrEqual(3 + 1e-6);
  });

  it("keys a kite's own tail parts instead of adding segments, and reuses its string on a second flight", () => {
    const t = kiteScene();
    const parts = [0, 1, 2, 3].map((i) =>
      t.doc.addObject({
        type: 'MESH',
        name: `tail.${i}`,
        data: t.mesh('bow', () => kiteMesh()),
        parent: t.kite,
        location: [0, 0, -0.4 - 0.3 * i],
        scale: [0.1, 0.1, 0.1],
      }),
    );
    const r = t.run('desk.tether_fly', { ...FLY, frame_start: 1, frame_end: 120 });
    expect(r.tail_objects.map((o: { object: string }) => o.object)).toEqual(parts.slice(1));
    const count = t.doc.listObjects().length;
    const again = t.run('desk.tether_fly', { ...FLY, frame_start: 1, frame_end: 150, seed: 3 });
    expect(again.string.object).toBe(r.string.object);
    expect(t.doc.listObjects()).toHaveLength(count);
  });

  it('refuses an anchor bone on an object that is not an armature, and a reversed range', () => {
    const t = kiteScene();
    expect(
      t.reg.run(t.ctx, 'desk.tether_fly', { ...FLY, anchor_bone: 'hand.R', frame_start: 1, frame_end: 20 }),
    ).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(t.reg.run(t.ctx, 'desk.tether_fly', { ...FLY, frame_start: 20, frame_end: 20 })).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS',
    });
  });
});
