import { describe, expect, it } from 'vitest';
import type { Mat4, Vec3 } from '../src/math/types';
import { SceneEvaluator } from '../src/eval/evaluate';
import { estimateOperator } from '../src/operators';
import { decomposeRigid } from '../src/physics/vmath';
import { DESK_PROPS } from '../src/desk/props';
import { getShots, setShots } from '../src/desk/shots';
import { checkShots } from '../src/desk/checks';
import { FLOAT_DEPTH_RADII, FLOAT_SETTLE_S, deskBakePlan } from '../src/desk/physics';
import { createCube } from '../src/mesh/primitives';
import { waterAt } from '../src/desk/water';
import { deskScene } from './desk-physics-helpers';
import { rideoCamera } from './desk-fixtures';

/*
 * Bodies that reach water float (desk.physics_bake's water: 'float', the default; desk/physics/
 * float.ts): a ball thrown into a pond comes to rest within 1.4 m of where it came in, floating a
 * quarter of its radius deep with a small bob, and keeps the frame it reached the water
 * (desk_floats); one dropped from high up floats from the frame before its fall would take it under
 * the surface, and one drifting to the water's edge stops there; a flat body (a book) lies flat with
 * its top above the water; a dense rock sinks; a ball that never reaches water is keyed exactly as
 * before, as is every body with water: 'ignore'. The release presets warn where a body reaches water.
 */

const R = 0.11;
/** The pond's surface: a 6 m square of water at x 3–9, y −3–3, 3 cm above the ground. */
const SURFACE = 0.03;

/** A scene with the pond (unless `dry`) and a ball in a hand 1.5 m up at the origin. */
function pondScene(o: { dry?: boolean } = {}) {
  const s = deskScene();
  if (!o.dry)
    s.plane('Pond', 6, {
      location: [6, 0, SURFACE],
      custom_props: { [DESK_PROPS.role]: 'landmark', [DESK_PROPS.label]: 'Pond', desk_shape: 'water' },
    });
  return { ...s, id: s.ball('Ball', [0, 0, 1.5], R) };
}

/** The keys of every F-curve of `id`, by path and index. */
function keysOf(s: ReturnType<typeof deskScene>, id: string) {
  return s.doc
    .listFCurves()
    .filter((fc) => fc.target_id === id)
    .map((fc) => [`${fc.path}[${fc.index}]`, fc.keyframes.map((k) => [k.frame, k.value])] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/** The ball's origin (its centre) at frames, as the baked keys put it. */
function centres(s: ReturnType<typeof deskScene>, id: string, frames: number[]): Vec3[] {
  const ev = new SceneEvaluator(s.doc);
  return frames.map((f) => {
    const m: Mat4 = ev.evaluate(f).byId.get(id)!.worldMatrix;
    return [m[12], m[13], m[14]];
  });
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const flat = (a: Readonly<Vec3>, b: Readonly<Vec3>) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('desk.physics_bake on water', () => {
  it('floats a ball thrown into a pond: it stops near where it came in, bobs and settles', () => {
    const s = pondScene();
    const throwResult = s.run('desk.physics_throw', {
      object: 'Ball',
      target: [6, 0, R],
      frame: 10,
      flight_s: 1,
    });
    expect(throwResult.landing_frame).toBe(34);
    const r = s.run('desk.physics_bake', {});
    expect(r.floats).toEqual([
      {
        object: s.id,
        name: 'Ball',
        frame: expect.any(Number),
        water: { object: expect.any(String), name: 'Pond', label: 'Pond' },
        sinks: false,
      },
    ]);
    const entry: number = r.floats[0].frame;
    // it reaches the water at the landing (or the frame before, falling onto it)
    expect(entry).toBeGreaterThanOrEqual(33);
    expect(entry).toBeLessThanOrEqual(34);
    expect(s.doc.getObject(s.id)!.custom_props[DESK_PROPS.floats]).toBe(entry);
    // keyed until it has settled, past the simulation's end if need be
    expect(r.frame_end).toBeGreaterThanOrEqual(entry + FLOAT_SETTLE_S * 24);
    const fps = 24;
    const settled = entry + Math.round(1.5 * fps);
    const frames = range(entry, r.frame_end);
    const c = centres(s, s.id, frames);
    const at = (f: number) => c[f - entry];
    // drifts on at most the speed the impact leaves it (2 m/s) decaying with a time constant of
    // 0.7 s, then stops (and a frame at most falling on onto the water at the throw's 6 m/s)
    const drift = flat(at(entry), at(r.frame_end));
    expect(drift).toBeGreaterThan(0.3);
    expect(drift).toBeLessThan(2 * 0.7 + 6 / 24);
    // 1.25 s in, what is left of it: at most 2 m/s × 0.7 s × e^(−1.2 s / 0.7 s) ≈ 0.25 m
    expect(flat(at(entry + 30), at(r.frame_end))).toBeLessThan(0.3);
    expect(flat(at(r.frame_end - 24), at(r.frame_end))).toBeLessThan(0.01);
    // at most 2 m/s × 0.7 s = 1.4 m from where it touched the water (about where it lands, its bottom
    // reaching the surface a few centimetres short of the throw's target)
    expect(flat([6, 0, 0], at(r.frame_end))).toBeLessThanOrEqual(1.4);
    // floating a quarter of its radius deep, bobbing within 1.5 cm at about half a hertz
    const depth = SURFACE - 0.25 * R;
    const heights = range(settled, settled + 4 * fps).map((f) => at(f)[2]);
    for (const z of heights) expect(Math.abs(z - depth)).toBeLessThanOrEqual(0.015 + 0.002);
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.015);
    // a bob every two seconds (half a hertz): rising through its mean height 48 frames apart
    const ups = range(settled, settled + 4 * fps - 1).filter(
      (f) => at(f)[2] <= depth && at(f + 1)[2] > depth,
    );
    expect(ups.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < ups.length; i++) expect(Math.abs(ups[i] - ups[i - 1] - 48)).toBeLessThanOrEqual(1);
    // and still at the end (the bob dies out before the last key)
    expect(Math.abs(at(r.frame_end)[2] - depth)).toBeLessThan(0.002);
  });

  it('keys a ball that never reaches the water exactly as without water', () => {
    const wet = pondScene();
    const dry = pondScene({ dry: true });
    for (const s of [wet, dry]) {
      s.run('desk.physics_throw', { object: 'Ball', target: [6, 6, R], frame: 10, flight_s: 1 });
      expect(s.warnings).toEqual([]);
    }
    const r = wet.run('desk.physics_bake', {});
    dry.run('desk.physics_bake', {});
    expect(r.floats).toEqual([]);
    expect(DESK_PROPS.floats in wet.doc.getObject(wet.id)!.custom_props).toBe(false);
    expect(keysOf(wet, wet.id)).toEqual(keysOf(dry, dry.id));
  });

  it("water: 'ignore' keys the simulation as it was: the ball bounces and rolls over the pond", () => {
    const wet = pondScene();
    const dry = pondScene({ dry: true });
    for (const s of [wet, dry])
      s.run('desk.physics_throw', { object: 'Ball', target: [6, 0, R], frame: 10, flight_s: 1 });
    const r = wet.run('desk.physics_bake', { water: 'ignore' });
    dry.run('desk.physics_bake', {});
    expect(r.floats).toEqual([]);
    expect(DESK_PROPS.floats in wet.doc.getObject(wet.id)!.custom_props).toBe(false);
    expect(keysOf(wet, wet.id)).toEqual(keysOf(dry, dry.id));
    // far past the pond
    const [end] = centres(wet, wet.id, [r.frame_end]);
    expect(end[0]).toBeGreaterThan(10);
  });

  it('sinks a body denser than water: two radii under the surface within about a second', () => {
    const s = pondScene();
    s.run('desk.physics_throw', { object: 'Ball', target: [6, 0, R], frame: 10, flight_s: 1 });
    // a 20 kg stone of the ball's size (about 3,600 kg/m³)
    const o = s.doc.getObject(s.id)!;
    s.doc.updateObject(s.id, { rigid_body: { ...o.rigid_body!, mass: 20 } });
    const r = s.run('desk.physics_bake', {});
    expect(r.floats).toMatchObject([{ sinks: true }]);
    const entry: number = r.floats[0].frame;
    const [later, end] = centres(s, s.id, [entry + 30, r.frame_end]);
    const depth = SURFACE - 2 * R;
    expect(Math.abs(later[2] - depth)).toBeLessThan(0.02);
    expect(Math.abs(end[2] - depth)).toBeLessThan(0.002);
  });

  it('is deterministic, and desk.check reports a body in the water only where it does not float', () => {
    const bake = (water?: string) => {
      const s = pondScene();
      s.run('desk.physics_throw', { object: 'Ball', target: [6, 0, R], frame: 10, flight_s: 1 });
      s.run('desk.physics_bake', water ? { water } : {});
      const cam = rideoCamera(s.doc, 'Wide', [5, 2, 14], [5, 0, 0], 24);
      setShots(s.doc, [{ name: 'S1', camera: cam, frame_start: 1, frame_end: 120, subjects: [s.id] }]);
      return s;
    };
    const a = bake();
    const b = bake();
    expect(keysOf(a, a.id)).toEqual(keysOf(b, b.id));
    const inWater = (s: ReturnType<typeof bake>) =>
      checkShots(s.doc).issues.filter((i) => i.code === 'body_in_water');
    expect(inWater(a)).toEqual([]);
    const ignored = bake('ignore');
    const [issue] = inWater(ignored);
    expect(issue.shot).toBe(getShots(ignored.doc)[0].id);
    expect(issue.message).toMatch(/^Ball is in the water of Pond in shot 'S1' \(frames? /);
  });

  it('is planned and estimated with the frames a float may add to a bake to the end', () => {
    const s = pondScene();
    s.run('desk.physics_throw', { object: 'Ball', target: [6, 0, R], frame: 10, flight_s: 1 });
    expect(deskBakePlan(s.doc, {}).float_frames).toBe(FLOAT_SETTLE_S * 24);
    expect(deskBakePlan(s.doc, { water: 'ignore' }).float_frames).toBe(0);
    expect(deskBakePlan(s.doc, { frame_end: 60 }).float_frames).toBe(0);
    const float = estimateOperator('desk.physics_bake', s.ctx, {})!;
    const ignore = estimateOperator('desk.physics_bake', s.ctx, { water: 'ignore' })!;
    // location and rotation, every frame a float may add
    expect(float.keyframes! - ignore.keyframes!).toBe(6 * FLOAT_SETTLE_S * 24);
    const r = s.run('desk.physics_bake', {});
    expect(r.keyframes).toBeLessThanOrEqual(float.keyframes!);
    const dry = pondScene({ dry: true });
    dry.run('desk.physics_throw', { object: 'Ball', target: [6, 0, R], frame: 10, flight_s: 1 });
    expect(deskBakePlan(dry.doc, {}).float_frames).toBe(0);
  });

  it('keeps the rotation of a floating ball turning less and less', () => {
    const s = pondScene();
    s.run('desk.physics_throw', {
      object: 'Ball',
      target: [6, 0, R],
      frame: 10,
      flight_s: 1,
      spin: [0, 12, 0],
    });
    const r = s.run('desk.physics_bake', {});
    const entry: number = r.floats[0].frame;
    const ev = new SceneEvaluator(s.doc);
    const turn = (f0: number, f1: number) => {
      const a = decomposeRigid(ev.evaluate(f0).byId.get(s.id)!.worldMatrix).rotation;
      const b = decomposeRigid(ev.evaluate(f1).byId.get(s.id)!.worldMatrix).rotation;
      // the angle between the two orientations
      const tr =
        a[0] * b[0] +
        a[1] * b[1] +
        a[2] * b[2] +
        a[3] * b[3] +
        a[4] * b[4] +
        a[5] * b[5] +
        a[6] * b[6] +
        a[7] * b[7] +
        a[8] * b[8];
      return Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2)));
    };
    const early = turn(entry + 1, entry + 3);
    const late = turn(entry + 30, entry + 32);
    expect(early).toBeGreaterThan(0.05);
    expect(late).toBeLessThan(early / 10);
  });
});

describe('floating bodies', () => {
  it('floats a ball dropped from high up from the frame before it would pass the surface, never deep', () => {
    // dropped from heights whose falls the simulation bounces off the ground under the water between
    // two frames (or not)
    for (const h of [1.6, 1.8, 2, 2.2, 2.4, 2.6]) {
      const drop = (water: string) => {
        const s = pondScene();
        s.doc.updateObject(s.id, { location: [6, 0, h] });
        s.run('desk.physics_drop', { objects: ['Ball'], frame: 5 });
        return { s, r: s.run('desk.physics_bake', { water }) };
      };
      const { s, r } = drop('float');
      const { s: dry, r: rd } = drop('ignore');
      // the last frame of the fall as simulated (the next one has bounced, or rests)
      const z = centres(dry, dry.id, range(5, rd.frame_end)).map((c) => c[2]);
      const last = 5 + z.findIndex((v, i) => i + 1 < z.length && z[i + 1] >= v);
      expect(r.floats).toMatchObject([{ sinks: false }]);
      const entry: number = r.floats[0].frame;
      expect(entry).toBeLessThanOrEqual(last);
      // and not before the frame before it
      expect(entry).toBeGreaterThanOrEqual(last - 1);
      // its impact taken by the water: never sunk to a radius under the surface
      for (const c of centres(s, s.id, range(entry, r.frame_end))) expect(c[2]).toBeGreaterThan(SURFACE - R);
    }
  });

  it("stops a ball drifting to the water's edge there: it never floats on over dry ground", () => {
    const s = pondScene();
    // landing 0.4 m short of the pond's far edge (x 9) at 8.6 m/s: it would drift on 1.4 m
    s.run('desk.physics_throw', { object: 'Ball', target: [8.6, 0, R], frame: 10, flight_s: 1 });
    const r = s.run('desk.physics_bake', {});
    const entry: number = r.floats[0].frame;
    const c = centres(s, s.id, range(entry, r.frame_end));
    for (const p of c) expect(waterAt(s.doc, p, 1)?.label).toBe('Pond');
    // stopped at the edge: within a frame's drift (2 m/s) of it
    expect(c[c.length - 1][0]).toBeGreaterThan(9 - 2 / 24);
    expect(flat(c[c.length - 2], c[c.length - 1])).toBe(0);
  });

  it('floats a flat body (a book) lying flat, with its top above the water', () => {
    const s = pondScene();
    // a book 30 × 22 × 3 cm (1 kg: half as dense as water), dropped tilted 57° from a metre up
    const dims: Vec3 = [0.3, 0.22, 0.03];
    const cube = createCube({ size: 1 });
    const book = s.doc.addObject({
      type: 'MESH',
      name: 'Book',
      data: s.mesh('book', () => ({ ...cube, positions: cube.positions.map((v, i) => v * dims[i % 3]) })),
      location: [6, 1, 1],
      rotation_euler: [1, 0, 0],
    });
    s.run('desk.physics_drop', { objects: ['Book'], frame: 5 });
    const r = s.run('desk.physics_bake', {});
    const f = r.floats.find((x: { object: string }) => x.object === book);
    expect(f).toMatchObject({ sinks: false });
    const ev = new SceneEvaluator(s.doc);
    const corners: Vec3[] = [];
    for (const x of [-0.5, 0.5])
      for (const y of [-0.5, 0.5])
        for (const z of [-0.5, 0.5]) corners.push([x * dims[0], y * dims[1], z * dims[2]]);
    // from 1.5 s after it came in to the end
    for (let frame = f.frame + 36; frame <= r.frame_end; frame++) {
      const m = ev.evaluate(frame).byId.get(book)!.worldMatrix;
      // its thin side (its own z) upright: lying flat (within 6°)
      expect(Math.abs(m[10])).toBeGreaterThan(Math.cos((6 * Math.PI) / 180));
      const zs = corners.map((p) => m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]);
      // its top out of the water, its bottom in it
      expect(Math.max(...zs)).toBeGreaterThan(SURFACE + 0.002);
      expect(Math.min(...zs)).toBeLessThan(SURFACE);
    }
    // a ball of its volume would float a quarter of its radius deep: deeper than the book's half thickness
    expect(FLOAT_DEPTH_RADII * Math.cbrt((3 * dims[0] * dims[1] * dims[2]) / (4 * Math.PI))).toBeGreaterThan(
      dims[2] / 2,
    );
  });
});

describe('the release presets', () => {
  it('warn where the body reaches water: desk.physics_bake makes it float (or sink) there', () => {
    const s = pondScene();
    s.run('desk.physics_throw', { object: 'Ball', target: [6, 0, R], frame: 10, flight_s: 1 });
    expect(s.warnings.splice(0)).toEqual([
      expect.stringMatching(
        /^'Ball' lands in the water of Pond \(frame 3[34]\); desk\.physics_bake makes it float there$/,
      ),
    ]);
    // landing on the grass short of the pond, it bounces on into it
    s.run('desk.physics_throw', { object: 'Ball', target: [1.5, 0, R], frame: 10, flight_s: 1 });
    expect(s.warnings.splice(0)).toEqual([
      expect.stringMatching(
        /^'Ball' comes down on dry ground but rolls or bounces into the water of Pond at frame \d+; desk\.physics_bake makes it float there \(aim it farther from the water to keep it on land\)$/,
      ),
    ]);
    // a 20 kg body dropped over the water
    const stone = s.ball('Stone', [6, 2, 1], R);
    s.run('desk.physics_setup', { objects: ['Stone'], mass: 20 });
    s.warnings.splice(0);
    s.run('desk.physics_drop', { objects: ['Stone'], frame: 5 });
    expect(s.warnings.splice(0)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^'Stone' reaches the water of Pond at frame \d+; desk\.physics_bake makes it sink there \(it is denser than water\)$/,
        ),
      ]),
    );
    // pushed away from the water: nothing to say
    s.run('desk.physics_push', { object: 'Ball', direction: [-1, 0, 0], speed_mps: 1, frame: 10 });
    expect(s.warnings.filter((w) => w.includes('water'))).toEqual([]);
    expect(stone).toBeTruthy();
  });

  it('desk.physics_push warns where it pushes a body into the water', () => {
    const s = pondScene();
    // on the grass a metre short of the pond, rolled toward it at 4 m/s
    s.doc.updateObject(s.id, { location: [2, 0, R] });
    s.run('desk.physics_push', { object: 'Ball', direction: [1, 0, 0], speed_mps: 4, frame: 10 });
    expect(s.warnings.filter((w) => w.includes('water'))).toEqual([
      expect.stringMatching(
        /^'Ball' reaches the water of Pond at frame \d+; desk\.physics_bake makes it float there$/,
      ),
    ]);
  });

  it('a body released again is no longer floating (desk_floats goes with the old bake)', () => {
    const s = pondScene();
    s.run('desk.physics_throw', { object: 'Ball', target: [6, 0, R], frame: 10, flight_s: 1 });
    s.run('desk.physics_bake', {});
    expect(DESK_PROPS.floats in s.doc.getObject(s.id)!.custom_props).toBe(true);
    s.run('desk.physics_drop', { objects: ['Ball'], frame: 5 });
    expect(DESK_PROPS.floats in s.doc.getObject(s.id)!.custom_props).toBe(false);
  });
});
