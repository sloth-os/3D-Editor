import { beforeAll, describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import type { Vec3 } from '../src/math/types';
import { FrameState } from '../src/eval/frame-state';
import { createOperatorRegistry } from '../src/operators';
import { DESK_PROPS } from '../src/desk/props';
import { getShots, newShotId, setShots } from '../src/desk/shots';
import {
  RIDEO_EXPORT_WALK_M,
  RideoSceneBlockingSchema,
  exportRideoBlocking,
  type RideoExportResult,
  type RideoImportResult,
  type RideoSceneBlocking,
} from '../src/desk/rideo';
import {
  CUP,
  DIALOGUE_SHOTS,
  KITE_SHOTS,
  LEO,
  MAYA,
  MUM,
  PEPPER,
  RIDING_SHOTS,
  ROSIE,
  SAM,
  dialogueClip,
  importClip,
  kiteClip,
  rideoContext,
  ridingClip,
  type ImportInput,
} from './desk-rideo-fixtures';

/*
 * desk.export_rideo_blocking (spec §11 "Export"): the scene as a rideo SceneBlocking v1 that rideo's
 * schema accepts, and the round trip import → export → import, which must stage the same scene.
 */

const NOW = '2026-11-13T12:00:00.000Z';

const unit = (v: readonly number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(...a.map((v, i) => v - b[i]));
const dir = (c: { x: number; y: number; z: number; targetX: number; targetY: number; targetZ: number }) =>
  unit([c.targetX - c.x, c.targetY - c.y, c.targetZ - c.z]);

interface Trip {
  first: { doc: SceneDoc; r: RideoImportResult; x: RideoExportResult };
  second: { doc: SceneDoc; r: RideoImportResult; x: RideoExportResult };
}

/**
 * Imports a clip, exports it, imports the export with the same clip around it (its shots' moves the
 * export's, as the push writes them to rideo's camera.move), and exports again.
 */
function roundTrip(clip: ImportInput): Trip {
  const run = (input: ImportInput) => {
    const doc = SceneDoc.create({ empty: true });
    const r = importClip(doc, input);
    return { doc, r, x: exportRideoBlocking(doc, { now: NOW }) };
  };
  const first = run(clip);
  const moves = new Map(first.x.shots.map((s) => [s.rideo_shot, s.move]));
  const second = run({
    ...clip,
    blocking: first.x.blocking,
    shots: clip.shots!.map((s) => ({ ...s, camera: { ...s.camera, move: moves.get(s.id) ?? null } })),
  });
  return { first, second };
}

/** Expects two imports to stage the same scene: shot frames, actors, cameras, holds, mounts, flights. */
function expectSameStaging(a: Trip['first'], b: Trip['second']) {
  expect(b.r.shots.map((s) => [s.rideo_shot, s.frame_start, s.frame_end, s.pre_roll, s.move])).toEqual(
    a.r.shots.map((s) => [s.rideo_shot, s.frame_start, s.frame_end, s.pre_roll, s.move]),
  );
  expect(b.r.actors.map((x) => [x.character_id, x.kind])).toEqual(
    a.r.actors.map((x) => [x.character_id, x.kind]),
  );
  expect(b.r.mounts).toEqual(a.r.mounts);
  expect(b.r.holds).toEqual(a.r.holds);
  expect(b.r.tethers.map((t) => [t.frame_start, t.frame_end])).toEqual(
    a.r.tethers.map((t) => [t.frame_start, t.frame_end]),
  );
  for (const [k, sa] of a.r.shots.entries()) {
    const sb = b.r.shots[k];
    for (const f of [sa.frame_start, sa.frame_end]) {
      const fa = new FrameState(a.doc, f);
      const fb = new FrameState(b.doc, f);
      for (const [j, actor] of a.r.actors.entries()) {
        const ma = fa.world(actor.id)!;
        const mb = fb.world(b.r.actors[j].id)!;
        // positions within the export's millimetres (walks end within a few centimetres of their mark)
        const tol = f === sa.frame_start ? 2e-3 : 0.05;
        expect(
          dist([ma[12], ma[13], ma[14]], [mb[12], mb[13], mb[14]]),
          `${actor.name} at ${f}`,
        ).toBeLessThan(tol);
        expect(dist([ma[4], ma[5]], [mb[4], mb[5]]), `${actor.name} facing at ${f}`).toBeLessThan(0.03);
      }
      const ca = fa.world(sa.camera)!;
      const cb = fb.world(sb.camera)!;
      expect(
        dist([ca[12], ca[13], ca[14]], [cb[12], cb[13], cb[14]]),
        `camera of ${sa.name} at ${f}`,
      ).toBeLessThan(2e-3);
      expect(
        dist([ca[8], ca[9], ca[10]], [cb[8], cb[9], cb[10]]),
        `camera aim of ${sa.name} at ${f}`,
      ).toBeLessThan(2e-3);
    }
    const lens = (doc: SceneDoc, cam: string) => doc.getCamera(doc.getObject(cam)!.data!)!.lens;
    expect(lens(b.doc, sb.camera), sa.name).toBeCloseTo(lens(a.doc, sa.camera), 2);
  }
}

/** Expects two exports to be the same blocking (props' resting place aside: a held prop is in a hand). */
function expectSameBlocking(a: RideoSceneBlocking, b: RideoSceneBlocking) {
  const strip = (x: RideoSceneBlocking) => ({ ...x, props: x.props.map((p) => ({ ...p, x: 0, z: 0 })) });
  const sa = strip(a);
  const sb = strip(b);
  expect(sb.set).toEqual(sa.set);
  expect(sb.actors).toEqual(sa.actors);
  expect(sb.props).toEqual(sa.props);
  expect(Object.keys(sb.shots)).toEqual(Object.keys(sa.shots));
  for (const [id, shot] of Object.entries(sa.shots)) {
    const other = sb.shots[id];
    expect(other.spec, id).toEqual(shot.spec);
    for (const [c, m] of Object.entries(shot.marks)) {
      const n = other.marks[c];
      expect([n.facingDeg, n.pose], `${id} ${c}`).toEqual([m.facingDeg, m.pose]);
      expect(Math.hypot(n.x - m.x, n.z - m.z), `${id} ${c}`).toBeLessThanOrEqual(2e-3);
      expect(n.toX === null, `${id} ${c} walks`).toBe(m.toX === null);
      if (m.toX !== null)
        expect(Math.hypot(n.toX! - m.toX, n.toZ! - m.toZ!), `${id} ${c}`).toBeLessThan(0.05);
    }
    expect(dist(dir(other.camera), dir(shot.camera)), id).toBeLessThan(2e-3);
    expect([other.camera.x, other.camera.y, other.camera.z, other.camera.lensMm]).toEqual([
      shot.camera.x,
      shot.camera.y,
      shot.camera.z,
      shot.camera.lensMm,
    ]);
    expect(other.camera.end === null, id).toBe(shot.camera.end === null);
  }
}

describe('rideo export: a dialogue', () => {
  let trip: Trip;
  let x: RideoSceneBlocking;
  beforeAll(() => {
    trip = roundTrip(dialogueClip());
    x = trip.first.x.blocking;
  });

  it("writes a SceneBlocking v1 rideo's schema accepts", () => {
    expect(RideoSceneBlockingSchema.safeParse(x).success).toBe(true);
    expect(x).toMatchObject({ version: 1, source: 'user', updatedAt: NOW });
    expect(trip.first.x.warnings).toEqual([]);
    expect(trip.first.x.shots.map((s) => s.rideo_shot)).toEqual([...DIALOGUE_SHOTS]);
  });

  it('writes the cast in order with their opening marks (the first shot’s start)', () => {
    expect(x.actors).toEqual([
      {
        id: 'a1',
        characterId: MAYA,
        color: '#ff8a3d',
        heightM: 1.4,
        x: -0.9,
        z: 0,
        facingDeg: 90,
        pose: 'stand',
      },
      {
        id: 'a2',
        characterId: LEO,
        color: '#3d8bff',
        heightM: 1.78,
        x: 0.9,
        z: 0,
        facingDeg: 270,
        pose: 'stand',
      },
    ]);
  });

  it('writes every shot’s marks with their facing, nearest pose and walk', () => {
    const s5 = x.shots[DIALOGUE_SHOTS[4]].marks;
    expect(s5[LEO]).toMatchObject({ x: 0.9, z: 0, facingDeg: 140 });
    expect(Math.hypot(s5[LEO].toX! - 2.8, s5[LEO].toZ! + 2.2)).toBeLessThan(0.25);
    expect(s5[MAYA]).toMatchObject({ x: -0.9, z: 0, toX: null, toZ: null });
    expect(x.shots[DIALOGUE_SHOTS[5]].marks[MAYA]).toMatchObject({
      x: -2.2,
      z: 1,
      facingDeg: 45,
      pose: 'point',
    });
    // a walk shorter than RIDEO_EXPORT_WALK_M is no walk
    for (const shot of Object.values(x.shots))
      for (const m of Object.values(shot.marks))
        if (m.toX !== null)
          expect(Math.hypot(m.toX - m.x, m.toZ! - m.z)).toBeGreaterThan(RIDEO_EXPORT_WALK_M);
  });

  it('writes the cameras where they stand, their aim, lens and end', () => {
    const blocked = (dialogueClip().blocking as RideoSceneBlocking).shots;
    for (const id of DIALOGUE_SHOTS) {
      const c = x.shots[id].camera;
      const b = blocked[id].camera;
      expect([c.x, c.y, c.z, c.lensMm], id).toEqual([b.x, b.y, b.z, b.lensMm]);
      expect(dist(dir(c), dir(b)), id).toBeLessThan(1e-3);
    }
    const push = x.shots[DIALOGUE_SHOTS[3]].camera.end!;
    expect([push.x, push.y, push.z]).toEqual([0.6, 1.25, 1]);
    expect(x.shots[DIALOGUE_SHOTS[0]].camera.end).toBeNull();
    // the spec keeps the shot's angle and height, with the move rideo's spec can name
    expect(x.shots[DIALOGUE_SHOTS[0]].spec).toEqual({
      subjects: [MAYA, LEO],
      angle: 'front',
      height: 'eye',
      move: 'none',
    });
    expect(x.shots[DIALOGUE_SHOTS[5]].spec).toEqual({
      subjects: [MAYA],
      angle: 'three_quarter_left',
      height: 'eye',
      move: 'none',
    });
    expect(x.shots[DIALOGUE_SHOTS[3]].spec).toBeNull();
  });

  it('writes the landmarks’ and props’ footprints, the held prop’s holder, and the set', () => {
    expect(x.set).toMatchObject({
      width: 10,
      depth: 8,
      ground: 'stone paving',
      interior: false,
      sun: { azimuthDeg: 140, elevationDeg: 50 },
    });
    expect(x.set.landmarks).toEqual([
      {
        id: 'l1',
        label: 'bistro table',
        shape: 'cylinder',
        x: 0,
        z: 0,
        width: 0.7,
        depth: 0.7,
        height: 1.05,
        rotationDeg: 0,
        color: '#8a8f98',
        elementId: 'ele_table000001b',
      },
      {
        id: 'l2',
        label: 'brick wall',
        shape: 'wall',
        x: 0,
        z: -3,
        width: 8,
        depth: 0.25,
        height: 3,
        rotationDeg: 0,
        color: '#8a8f98',
        elementId: null,
      },
    ]);
    expect(x.props).toEqual([
      expect.objectContaining({
        id: 'p1',
        elementId: CUP,
        label: 'teacup',
        size: 0.12,
        color: '#f4efe6',
        heldBy: LEO,
      }),
    ]);
  });

  it('round-trips: the export imported again stages the same scene and exports the same blocking', () => {
    expectSameStaging(trip.first, trip.second);
    expectSameBlocking(trip.first.x.blocking, trip.second.x.blocking);
  });
});

describe('rideo export: riding and a kite', () => {
  it("puts a rider on her mount's mark, seated, and round-trips the ride", () => {
    const trip = roundTrip(ridingClip());
    const x = trip.first.x.blocking;
    const ride = x.shots[RIDING_SHOTS[1]].marks;
    expect(ride[ROSIE]).toMatchObject({ x: ride[PEPPER].x, z: ride[PEPPER].z, pose: 'sit', facingDeg: 90 });
    expect(Math.hypot(ride[PEPPER].toX! - 2.5, ride[PEPPER].toZ! + 2.5)).toBeLessThan(0.3);
    expect(ride[ROSIE]).toMatchObject({ toX: ride[PEPPER].toX, toZ: ride[PEPPER].toZ });
    expect(x.shots[RIDING_SHOTS[2]].marks[ROSIE]).toMatchObject({
      x: 3.4,
      z: -0.7,
      facingDeg: 180,
      pose: 'stand',
    });
    const pond = x.set.landmarks.find((l) => l.label === 'pond')!;
    expect(pond).toMatchObject({ shape: 'water', x: -5, z: 3.5, width: 3, depth: 2, height: 0.05 });
    expect(x.shots[RIDING_SHOTS[1]].camera.end).toMatchObject({ x: 0, y: 1.5, z: 1.5 });
    expectSameStaging(trip.first, trip.second);
    expectSameBlocking(trip.first.x.blocking, trip.second.x.blocking);
  });

  it("names the kite's holder from its string, writes the solved shot's camera, and round-trips the flight", () => {
    const trip = roundTrip(kiteClip());
    const x = trip.first.x.blocking;
    expect(x.props).toEqual([
      expect.objectContaining({ id: 'p1', label: 'kite', size: 0.9, color: '#e5484d', heldBy: SAM }),
    ]);
    // the shot rideo had not blocked has the camera the import solved
    expect(Object.keys(x.shots)).toEqual([...KITE_SHOTS]);
    const solved = x.shots[KITE_SHOTS[3]].camera;
    expect(solved.lensMm).toBeGreaterThanOrEqual(8);
    expect(x.shots[KITE_SHOTS[2]].marks[SAM]).toMatchObject({ x: 0, z: 0, pose: 'run' });
    expect(
      Math.hypot(x.shots[KITE_SHOTS[2]].marks[SAM].toX!, x.shots[KITE_SHOTS[2]].marks[SAM].toZ! + 6),
    ).toBeLessThan(0.3);
    const bench = x.set.landmarks.find((l) => l.label === 'park bench')!;
    expect(bench.rotationDeg).toBeCloseTo(20, 1);
    // a built-in model's footprint is centred on rideo's mark (the oak's crown leans off its trunk)
    expect(x.set.landmarks.find((l) => l.label === 'oak tree')).toMatchObject({
      x: 7,
      z: -8,
      width: 1.6,
      depth: 1.6,
      height: 7,
      elementId: 'ele_oaktree0001e',
    });
    expectSameStaging(trip.first, trip.second);
    expectSameBlocking(trip.first.x.blocking, trip.second.x.blocking);
  });
});

describe('rideo export: what the import left out', () => {
  it('writes back a character in no shot as rideo has it, its marks and the prop it holds', () => {
    const DAD = 'chr_dad00000001g';
    const clip = kiteClip();
    const blocking = clip.blocking as RideoSceneBlocking;
    const dad = {
      id: 'a3',
      characterId: DAD,
      color: '#30a46c',
      heightM: 1.82,
      x: 4,
      z: 2,
      facingDeg: 200,
      pose: 'stand' as const,
    };
    blocking.actors.push(dad);
    blocking.props[0].heldBy = DAD;
    const waving = { x: 3.5, z: 1.5, facingDeg: 180, pose: 'wave' as const, toX: null, toZ: null };
    blocking.shots[KITE_SHOTS[1]].marks = { [DAD]: waving };
    clip.characters!.push({ id: DAD, name: 'Dad', summary: "Sam's dad." });
    const doc = SceneDoc.create({ empty: true });
    const r = importClip(doc, clip);
    // left out of the scene (rideo draws him in no shot), and the kite he holds hidden
    expect(r.warnings).toContain('Dad is in the blocking but in no shot: left out');
    expect(r.warnings).toContain("'kite' is held by Dad, who is in no shot: it is hidden");
    expect(r.actors.map((a) => a.character_id)).toEqual([SAM, MUM]);
    const x = exportRideoBlocking(doc, { now: NOW });
    expect(x.blocking.actors.map((a) => a.characterId)).toEqual([SAM, MUM, DAD]);
    expect(x.blocking.actors[2]).toEqual(dad);
    expect(x.blocking.props).toEqual([expect.objectContaining({ id: 'p1', label: 'kite', heldBy: DAD })]);
    expect(x.blocking.shots[KITE_SHOTS[1]].marks[DAD]).toEqual(waving);
    expect(RideoSceneBlockingSchema.safeParse(x.blocking).success).toBe(true);
    // imported again, the export leaves him out the same way, and writes him back the same way
    const again = SceneDoc.create({ empty: true });
    importClip(again, { ...clip, blocking: x.blocking });
    const y = exportRideoBlocking(again, { now: NOW });
    expect(y.blocking.actors[2]).toEqual(dad);
    expect(y.blocking.props[0].heldBy).toBe(DAD);
    // a character the desk has again is the desk's: no record writes over it
    const none = exportRideoBlocking(SceneDoc.create({ empty: true }), { now: NOW });
    expect(none.blocking.actors).toEqual([]);
  });
});

describe('rideo export: scenes not made by the import', () => {
  it("exports shots and actors without rideo ids under the desk's own, or leaves them out, saying so", () => {
    const doc = SceneDoc.create({ empty: true });
    importClip(doc, dialogueClip());
    const shot = { ...getShots(doc)[0], id: newShotId(), name: 'Insert', external: null };
    setShots(doc, [...getShots(doc), shot]);
    doc.addObject({ type: 'EMPTY', name: 'Extra', custom_props: { [DESK_PROPS.role]: 'actor' } });
    const r = exportRideoBlocking(doc, { now: NOW });
    expect(Object.keys(r.blocking.shots)).toEqual([...DIALOGUE_SHOTS, shot.id]);
    expect(r.warnings).toContain(
      "shot 'Insert' has no rideo shot id: exported under its own id (rideo keeps only its clip's shots)",
    );
    expect(r.warnings).toContain("actor 'Extra' has no rideo character id: left out");
    expect(r.blocking.actors).toHaveLength(2);
  });

  it('exports an empty scene as an empty blocking', () => {
    const r = exportRideoBlocking(SceneDoc.create({ empty: true }), { now: NOW });
    expect(r.blocking).toMatchObject({ actors: [], props: [], shots: {}, set: { landmarks: [] } });
    expect(RideoSceneBlockingSchema.safeParse(r.blocking).success).toBe(true);
  });

  it('runs as desk.export_rideo_blocking without changing the scene', () => {
    const doc = SceneDoc.create({ empty: true });
    importClip(doc, ridingClip());
    const before = JSON.stringify(doc.listObjects());
    const reg = createOperatorRegistry();
    const res = reg.run<RideoExportResult>(rideoContext(doc), 'desk.export_rideo_blocking', {});
    expect(res.ok, res.error).toBe(true);
    expect(Object.keys(res.result!.blocking.shots)).toEqual([...RIDING_SHOTS]);
    expect(JSON.stringify(doc.listObjects())).toBe(before);
  });
});

describe('rideo export: cameras rideo blocked', () => {
  /** The kite clip with a blocked push-in on its first shot: a far target at its start, a near one at its end. */
  function pushIn(): ImportInput {
    const clip = kiteClip();
    const blocking = clip.blocking as RideoSceneBlocking;
    blocking.shots[KITE_SHOTS[0]].camera = {
      x: 0.3,
      y: 1.6,
      z: 6,
      targetX: -1,
      targetY: 1,
      targetZ: -20,
      lensMm: 35,
      end: { x: 0.1, y: 1.4, z: 3, targetX: 0.6, targetY: 1, targetZ: 0 },
    };
    clip.shots![0].camera = { framing: 'wide', movement: 'dolly_in' };
    return clip;
  }

  it("gives rideo's own placement back, so a push-in keeps its middle through a round trip", () => {
    const clip = pushIn();
    const trip = roundTrip(clip);
    // rideo's targets as they were: the desk keys its move between them, recomputed targets (on the
    // same aim, at other distances) would turn the middle of the move
    expect(trip.first.x.blocking.shots[KITE_SHOTS[0]].camera).toEqual(
      (clip.blocking as RideoSceneBlocking).shots[KITE_SHOTS[0]].camera,
    );
    const a = trip.first.r.shots[0];
    const b = trip.second.r.shots[0];
    expect([a.move, b.move]).toEqual(['push_in', 'push_in']);
    for (let f = a.frame_start; f <= a.frame_end; f += 8) {
      const wa = new FrameState(trip.first.doc, f).world(a.camera)!;
      const wb = new FrameState(trip.second.doc, f).world(b.camera)!;
      const aim = (w: readonly number[]) => unit([-w[8], -w[9], -w[10]]);
      const cos = aim(wa).reduce((s, v, i) => s + v * aim(wb)[i], 0);
      expect((Math.acos(Math.min(1, cos)) * 180) / Math.PI, `aim at frame ${f}`).toBeLessThan(1e-3);
      expect(dist([wa[12], wa[13], wa[14]], [wb[12], wb[13], wb[14]]), `position at ${f}`).toBeLessThan(1e-6);
    }
  });

  it('writes the camera as the desk has it once it was moved, keyed or solved again', () => {
    const doc = SceneDoc.create({ empty: true });
    const r = importClip(doc, pushIn());
    const cam = r.shots[0].camera;
    // the camera's move shifted 2 m along x (its location keys)
    const fc = doc.listFCurves(cam).find((c) => c.path === 'location' && c.index === 0)!;
    doc.setFCurve({ ...fc, keyframes: fc.keyframes.map((k) => ({ ...k, value: k.value + 2 })) });
    const x = exportRideoBlocking(doc, { now: NOW });
    const exported = x.blocking.shots[KITE_SHOTS[0]].camera!;
    // the camera where it now starts (2 m further along x, rideo's x too), aimed as it is: not
    // rideo's placement, which it left
    expect(exported.x).toBeCloseTo(2.3, 3);
    expect(exported.targetZ).not.toBe(-20);
  });
});
