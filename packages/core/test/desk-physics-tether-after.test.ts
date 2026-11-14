import { describe, expect, it } from 'vitest';
import type { Mat4, Vec3 } from '../src/math/types';
import { TETHER_LAND_SECONDS, TETHER_TAIL_SETTLE_SECONDS, tetherLandSeconds } from '../src/desk/physics';
import { TETHER_HIDDEN_SCALE, tetherFly } from '../src/desk/physics/tether';
import { sceneSampler } from '../src/desk/physics/common';
import { deskScene, dist, kiteMesh, originOf, transformPoint } from './desk-physics-helpers';

/*
 * desk.tether_fly after frame_end (review F9 of the Kite Day film): 'hold' (the default) leaves the
 * flyer, its tail and its string where the flight ends; 'hide' hides them from frame_end + 1 for good
 * (their keyed scale shrinks them to nothing: renders, the viewport and the export's string overlay
 * draw none of them), a later flight showing the flyer again; 'land' brings a kite down (slower than a
 * dropped stone: 1.6 times a free fall's time, at least 1.5 s) to lie flat on the ground downwind of
 * the anchor, its tail lying after it and its string hidden.
 */

type Scene = ReturnType<typeof deskScene>;

/** The corners of the test kite (kiteMesh), in its object space. */
const KITE_CORNERS: Vec3[] = [
  [0, 0, 0.6],
  [0.4, 0, 0],
  [0, 0, -0.4],
  [-0.4, 0, 0],
];
const ANCHOR: Vec3 = [0, 0, 1.2];
/** The wind blows toward +X. */
const FLY = { flyer: 'Kite', anchor: 'Hand', length_m: 20, wind_dir_deg: 90, wind_mps: 6 } as const;
const FPS = 24;

function kiteScene(): Scene & { kite: string } {
  const s = deskScene();
  const kite = s.doc.addObject({
    type: 'MESH',
    name: 'Kite',
    data: s.mesh('kite', kiteMesh),
    location: [0.5, 0, 1.3],
  });
  s.empty('Hand', ANCHOR);
  return { ...s, kite };
}

/** A store kite (its own tail parts, sail, spars and bridle under an EMPTY root) and the hand. */
function storeKiteScene(): Scene & { kite: { root: string; objects: string[] } } {
  const s = deskScene();
  const kite = s.run('store.add', { model: 'diamond_kite', location: [0.6, 0, 0.05], name: 'Kite' });
  s.empty('Hand', ANCHOR);
  return { ...s, kite };
}

/** World matrix of `id` at `frame` (its keys, constraints and parents). */
const worldAt = (s: Scene, id: string, frame: number): Mat4 => sceneSampler(s.doc).at(frame).world(id)!;

/** Longest column of a world matrix: the scale an object is drawn at. */
const drawnScale = (m: Mat4): number =>
  Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10]));

/** World-space bounds of an object's mesh at `frame`. */
function meshBounds(s: Scene, id: string, frame: number): { min: Vec3; max: Vec3; diagonal: number } {
  const w = worldAt(s, id, frame);
  const positions = s.doc.getMesh(s.doc.getObject(id)!.data!)!.positions;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const p = transformPoint(w, [positions[i], positions[i + 1], positions[i + 2]]);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  return { min, max, diagonal: dist(min, max) };
}

/** Lowest corner of the test kite posed by its world matrix `m`. */
const lowestCorner = (m: Mat4): number => Math.min(...KITE_CORNERS.map((c) => transformPoint(m, c)[2]));

const ids = (objects: { object: string }[]): string[] => objects.map((o) => o.object);

describe('desk.tether_fly after the flight', () => {
  it("'hold' (the default) leaves the kite, its tail and its string where the flight ends", () => {
    const t = kiteScene();
    const r = t.run('desk.tether_fly', { ...FLY, frame_start: 1, frame_end: 240 });
    expect(r).toMatchObject({ after: 'hold', hidden_from: null, landed_frame: null });
    const end = worldAt(t, t.kite, 240);
    for (const f of [241, 400]) {
      expect(worldAt(t, t.kite, f)).toEqual(end);
      expect(meshBounds(t, r.string.object, f).diagonal).toBeGreaterThan(5);
      for (const id of ids(r.tail_objects)) expect(drawnScale(worldAt(t, id, f))).toBeCloseTo(1, 6);
    }
  });

  it("'hide' hides the kite, its tail and its string from frame_end + 1 on, for good", () => {
    const t = kiteScene();
    const r = t.run('desk.tether_fly', { ...FLY, frame_start: 1, frame_end: 240, after: 'hide' });
    expect(r).toMatchObject({ after: 'hide', hidden_from: 241, landed_frame: null });
    const shown = [t.kite, ...ids(r.tail_objects)];
    expect(shown).toHaveLength(1 + 5);
    // shown before and through the flight
    expect(drawnScale(worldAt(t, t.kite, 0))).toBeCloseTo(1, 6);
    for (const f of [120, 240]) {
      for (const id of shown) expect(drawnScale(worldAt(t, id, f)), `frame ${f}`).toBeCloseTo(1, 6);
      expect(meshBounds(t, r.string.object, f).diagonal).toBeGreaterThan(5);
    }
    const last = originOf(worldAt(t, t.kite, 240));
    for (const f of [241, 242, 300, 5000]) {
      for (const id of shown)
        expect(drawnScale(worldAt(t, id, f)), `frame ${f}`).toBeLessThanOrEqual(TETHER_HIDDEN_SCALE * 1.001);
      // under the micrometre below which nothing draws (the export's string overlay included)
      expect(meshBounds(t, r.string.object, f).diagonal, `frame ${f}`).toBeLessThan(1e-6);
      expect(meshBounds(t, t.kite, f).diagonal, `frame ${f}`).toBeLessThan(1e-6);
      // put away where the flight left it
      expect(dist(originOf(worldAt(t, t.kite, f)), last)).toBeLessThan(1e-9);
    }
  });

  it("'hide' puts away a store kite with every part and its own tail through its root", () => {
    const t = storeKiteScene();
    const r = t.run('desk.tether_fly', { ...FLY, frame_start: 1, frame_end: 200, after: 'hide' });
    expect(r.flyer.object).toBe(t.kite.root);
    expect(r.hidden_from).toBe(201);
    const meshes = t.kite.objects.filter((id) => t.doc.getObject(id)!.type === 'MESH');
    expect(meshes.length).toBeGreaterThanOrEqual(4);
    for (const id of meshes) {
      expect(meshBounds(t, id, 200).diagonal, t.doc.getObject(id)!.name).toBeGreaterThan(0.05);
      for (const f of [201, 1000])
        expect(meshBounds(t, id, f).diagonal, `${t.doc.getObject(id)!.name} ${f}`).toBeLessThan(1e-6);
    }
    expect(meshBounds(t, r.string.object, 201).diagonal).toBeLessThan(1e-6);
  });

  it('a later flight of a hidden kite that fails leaves its hiding exactly as it was', () => {
    const t = kiteScene();
    t.run('desk.tether_fly', { ...FLY, frame_start: 1, frame_end: 120, after: 'hide' });
    const hand = t.doc.listObjects().find((o) => o.name === 'Hand')!.id;
    const scales = () => t.doc.listFCurves(t.kite).filter((fc) => fc.path === 'scale');
    const before = {
      scales: structuredClone(scales()),
      props: structuredClone(t.doc.getObject(t.kite)!.custom_props),
    };
    expect(before.scales).toHaveLength(3);
    expect(before.props?.desk_tether_hidden_from).toBe(121);
    // a document that fails the first read after the flight has shown the kite again (its hiding
    // keys and property changed for the flight), as any failure inside the flight would
    let shown = false;
    let failed = false;
    const doc = t.doc;
    const failing = new Proxy(doc, {
      get(target, key) {
        const v: unknown = Reflect.get(target, key, target);
        if (key === 'updateObject')
          return (id: string, patch: Parameters<typeof doc.updateObject>[1]) => {
            const r = doc.updateObject(id, patch);
            if (id === t.kite && patch.custom_props && !('desk_tether_hidden_from' in patch.custom_props))
              shown = true;
            return r;
          };
        if (key === 'getObject')
          return (id: string) => {
            if (shown && !failed) {
              failed = true;
              throw new Error('the document failed');
            }
            return doc.getObject(id);
          };
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    expect(() =>
      tetherFly(failing, { ...FLY, flyer: t.kite, anchor: hand, frame_start: 200, frame_end: 300 }),
    ).toThrow('the document failed');
    // the flight had shown the kite before it failed: what it changed is put back exactly
    expect(failed).toBe(true);
    expect(scales()).toEqual(before.scales);
    expect(t.doc.getObject(t.kite)!.custom_props).toEqual(before.props);
  });

  it('shows a hidden kite again for a later flight; flying the same range again replaces the hiding', () => {
    const t = kiteScene();
    t.run('desk.tether_fly', { ...FLY, frame_start: 1, frame_end: 120, after: 'hide' });
    expect(t.doc.getObject(t.kite)!.custom_props?.desk_tether_hidden_from).toBe(121);
    // a later flight: hidden between the two, shown again from the second on
    t.run('desk.tether_fly', { ...FLY, frame_start: 200, frame_end: 300 });
    const scale = (s: Scene & { kite: string }, f: number) => drawnScale(worldAt(s, s.kite, f));
    expect(scale(t, 120)).toBeCloseTo(1, 6);
    for (const f of [121, 199]) expect(scale(t, f), `frame ${f}`).toBeLessThan(1e-6);
    for (const f of [200, 300, 500]) expect(scale(t, f), `frame ${f}`).toBeCloseTo(1, 6);
    expect(t.doc.getObject(t.kite)!.custom_props?.desk_tether_hidden_from).toBeUndefined();

    // flown again over the same range: the new flight's `after` decides
    const u = kiteScene();
    u.run('desk.tether_fly', { ...FLY, frame_start: 1, frame_end: 120, after: 'hide' });
    u.run('desk.tether_fly', { ...FLY, frame_start: 1, frame_end: 120 });
    for (const f of [121, 500]) expect(scale(u, f), `frame ${f}`).toBeCloseTo(1, 6);
    expect(u.doc.listFCurves(u.kite).some((fc) => fc.path === 'scale')).toBe(false);
    u.run('desk.tether_fly', { ...FLY, frame_start: 1, frame_end: 150, after: 'hide' });
    expect(scale(u, 121)).toBeCloseTo(1, 6);
    expect(scale(u, 150)).toBeCloseTo(1, 6);
    expect(scale(u, 151)).toBeLessThan(1e-6);
  });

  it("'land' brings a kite down, slower than a dropped stone, to lie flat downwind of the anchor, its tail after it", () => {
    const t = kiteScene();
    const r = t.run('desk.tether_fly', { ...FLY, frame_start: 1, frame_end: 300, after: 'land' });
    const landed = r.landed_frame;
    expect(r).toMatchObject({ after: 'land', hidden_from: null });
    expect(lowestCorner(worldAt(t, t.kite, 300))).toBeGreaterThan(10);
    // on its way down: lower on every frame, never under the ground
    let previous = Infinity;
    let fastest = 0;
    for (let f = 300; f <= landed; f++) {
      const k = worldAt(t, t.kite, f);
      expect(lowestCorner(k), `frame ${f}`).toBeGreaterThanOrEqual(0);
      expect(k[14], `frame ${f}`).toBeLessThanOrEqual(previous);
      if (f > 300) fastest = Math.max(fastest, (previous - k[14]) * FPS);
      previous = k[14];
    }
    // from 17.7 m it takes 1.6 times a free fall's √(2h/g), about 3 s (it took 1.5 s from any height,
    // reaching the ground at about 24 m/s), never more than half a falling stone's speed, and it
    // touches down softly
    const drop = worldAt(t, t.kite, 300)[14] - worldAt(t, t.kite, landed)[14];
    expect(drop).toBeGreaterThan(15);
    expect((landed - 300) / FPS).toBeGreaterThan(2 * TETHER_LAND_SECONDS);
    expect(Math.abs(landed - 300 - tetherLandSeconds(drop) * FPS)).toBeLessThan(2.5);
    expect(fastest).toBeLessThan(0.5 * Math.sqrt(2 * 9.81 * drop));
    const touchdown = (worldAt(t, t.kite, landed - 1)[14] - worldAt(t, t.kite, landed)[14]) * FPS;
    expect(touchdown).toBeLessThan(0.5);
    // on the ground from `landed` on: flat on its face (its front, −Y, down), just above the ground
    const rest = worldAt(t, t.kite, landed);
    for (const f of [landed, landed + 50, 3000]) {
      const k = worldAt(t, t.kite, f);
      for (let i = 0; i < 16; i++) expect(k[i], `frame ${f} [${i}]`).toBeCloseTo(rest[i], 9);
    }
    expect(rest[6]).toBeGreaterThan(0.999);
    expect(lowestCorner(rest)).toBeLessThan(0.01);
    // downwind of the anchor, nearer than it flew, its nose (+Z) toward the anchor
    const o = originOf(rest);
    const flown = originOf(worldAt(t, t.kite, 300));
    expect(o[0] - ANCHOR[0]).toBeGreaterThan(5);
    expect(o[0]).toBeLessThan(flown[0]);
    const away = Math.hypot(ANCHOR[0] - o[0], ANCHOR[1] - o[1]);
    expect((rest[8] * (ANCHOR[0] - o[0]) + rest[9] * (ANCHOR[1] - o[1])) / away).toBeGreaterThan(0.99);
    // the string: let go at the flight's end, hidden from the next frame
    expect(meshBounds(t, r.string.object, 300).diagonal).toBeGreaterThan(5);
    for (const f of [301, landed, 3000])
      expect(meshBounds(t, r.string.object, f).diagonal).toBeLessThan(1e-6);
    // the tail falls after it and lies on the ground downwind of it, then stays
    const settled = landed + Math.round(TETHER_TAIL_SETTLE_SECONDS * FPS);
    const tail = ids(r.tail_objects).map((id) => originOf(worldAt(t, id, settled)));
    expect(tail).toHaveLength(5);
    tail.forEach((p, i) => {
      expect(p[2], `segment ${i}`).toBeLessThan(0.02);
      expect(p[0], `segment ${i}`).toBeGreaterThan(i ? tail[i - 1][0] : o[0]);
    });
    for (const id of ids(r.tail_objects))
      expect(dist(originOf(worldAt(t, id, settled)), originOf(worldAt(t, id, 3000)))).toBeLessThan(1e-9);
  });

  it("lands a store kite's sail on the ground with its own tail's bows lying flat after it", () => {
    const t = storeKiteScene();
    const r = t.run('desk.tether_fly', { ...FLY, frame_start: 1, frame_end: 300, after: 'land' });
    const settled = r.landed_frame + Math.round(TETHER_TAIL_SETTLE_SECONDS * FPS);
    const named = (name: string) => t.kite.objects.find((id) => t.doc.getObject(id)!.name === name)!;
    const sail = meshBounds(t, named('sail'), settled);
    expect(sail.min[2]).toBeGreaterThanOrEqual(0);
    expect(sail.max[2]).toBeLessThan(0.02);
    const bows = ids(r.tail_objects);
    expect(bows.map((id) => t.doc.getObject(id)!.name)).toEqual(['tail.2', 'tail.3', 'tail.4', 'tail.5']);
    // downwind (+X) of the sail one after the other
    let downwind = (sail.min[0] + sail.max[0]) / 2;
    for (const id of bows) {
      const name = t.doc.getObject(id)!.name;
      const b = meshBounds(t, id, settled);
      // flat on the ground (as they hang under the sail), not standing on an edge half in it
      expect(b.min[2], name).toBeGreaterThanOrEqual(0);
      expect(b.max[2] - b.min[2], name).toBeLessThan(0.02);
      const middle = (b.min[0] + b.max[0]) / 2;
      expect(middle, name).toBeGreaterThan(downwind);
      downwind = middle;
    }
  });

  it("refuses 'land' for a balloon before changing anything, and hides one", () => {
    const b = deskScene();
    const balloon = b.ball('Red Balloon', [0.3, 0, 1.5], 0.3);
    b.empty('Hand', ANCHOR);
    const p = {
      flyer: 'Red Balloon',
      anchor: 'Hand',
      length_m: 3,
      wind_dir_deg: 0,
      wind_mps: 1,
      frame_start: 1,
      frame_end: 48,
    };
    const objects = b.doc.listObjects().length;
    const refused = b.reg.run(b.ctx, 'desk.tether_fly', { ...p, after: 'land' });
    expect(refused).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(!refused.ok && refused.error).toMatch(/balloon does not come down/);
    expect(b.doc.listObjects()).toHaveLength(objects);
    expect(b.doc.listFCurves()).toHaveLength(0);
    expect(b.reg.run(b.ctx, 'desk.tether_fly', { ...p, after: 'away' })).toMatchObject({ ok: false });
    const r = b.run('desk.tether_fly', { ...p, after: 'hide' });
    expect(drawnScale(worldAt(b, balloon, 48))).toBeCloseTo(1, 6);
    expect(drawnScale(worldAt(b, balloon, 49))).toBeLessThan(1e-6);
    expect(meshBounds(b, r.string.object, 49).diagonal).toBeLessThan(1e-6);
  });
});
