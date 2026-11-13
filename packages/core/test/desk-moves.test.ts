import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/math/types';
import type { SceneDoc } from '../src/doc/scene-doc';
import { DESK_MOVES, type DeskMove } from '../src/doc/types';
import { createFCurve, insertKeyframe } from '../src/anim/fcurve';
import { DeskScene, projectPoint, type CameraView } from '../src/desk/layout';
import {
  DRONE_KEYS,
  DRONE_RISE_M,
  HANDHELD_LOCATION_M,
  PAN_DEG,
  STEADICAM_BOB_M,
  TILT_DEG,
  WHIP_DEG,
  WHIP_FRAMES,
  addDeskCamera,
  applyCameraMove,
  cameraMoveKeys,
  clearCameraRange,
  orbitKeyCount,
  prepareDeskCamera,
  retimeCameraRange,
  type CameraPose,
} from '../src/desk/moves';
import { deskDoc, ed, expectNear, rideo, rideoCamera, standIn } from './desk-fixtures';

/*
 * Camera moves keyed over a shot's range (desk/moves.ts): where each of rideo's twenty moves starts
 * and ends, how it is keyed (eased, along arcs, by rotation, noise, lens, focus, following a
 * subject), and how keying a range replaces only that range.
 */

const START: CameraPose = { position: ed(0, 1.581, 2.131), target: ed(0, 1.224, 0), lens: 35 };
const FS = 1;
const FE = 49;

function setup() {
  const doc = deskDoc();
  const ada = standIn(doc, 'Ada', 0, 0, 0);
  const ben = standIn(doc, 'Ben', 0.6, -3, 0);
  const cam = rideoCamera(doc, 'Cam', [0, 1.581, 2.131], [0, 1.224, 0], 35);
  return { doc, ada, ben, cam };
}

const viewAt = (doc: SceneDoc, cam: string, frame: number): CameraView =>
  new DeskScene(doc).camera(cam, frame)!;

/** The angle (radians) between where a view looks and the direction to `target`. */
function aim(v: CameraView, target: Readonly<Vec3>): number {
  const d: Vec3 = [target[0] - v.position[0], target[1] - v.position[1], target[2] - v.position[2]];
  const n = Math.hypot(...d);
  const c = (d[0] * v.forward[0] + d[1] * v.forward[1] + d[2] * v.forward[2]) / n;
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

/** Keys of the camera's F-curve `path`[`index`] within [a, b]. */
function keysIn(
  doc: SceneDoc,
  cam: string,
  path: string,
  index: number,
  a = -Infinity,
  b = Infinity,
): number[] {
  const fc = doc.listFCurves(cam).find((f) => f.path === path && f.index === index);
  return (fc?.keyframes ?? []).map((k) => k.frame).filter((f) => f >= a && f <= b);
}

const heading = (v: CameraView): number => Math.atan2(v.forward[1], v.forward[0]);
const deg = (r: number): number => (r * 180) / Math.PI;

function keyLocation(doc: SceneDoc, id: string, keys: [number, Vec3][]): void {
  for (let i = 0; i < 3; i++) {
    let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: i });
    for (const [f, v] of keys) fc = insertKeyframe(fc, f, v[i], 'LINEAR');
    doc.setFCurve(fc);
  }
}

function keyHeading(doc: SceneDoc, id: string, keys: [number, number][]): void {
  let fc = createFCurve({ target_type: 'object', target_id: id, path: 'rotation_euler', index: 2 });
  for (const [f, d] of keys) fc = insertKeyframe(fc, f, (d * Math.PI) / 180, 'LINEAR');
  doc.setFCurve(fc);
}

describe('camera moves', () => {
  it('start every move from the given pose and end where they say, keying no more than the estimates count', () => {
    for (const move of DESK_MOVES) {
      const { doc, ada, ben, cam } = setup();
      const r = applyCameraMove(doc, cam, move, {
        frame_start: FS,
        frame_end: FE,
        start: START,
        seed: 'shot',
        subject: ada,
        subjects: [ada, ben],
        keyed: true,
      });
      const first = viewAt(doc, cam, FS);
      const tol = move === 'handheld' ? 2 * HANDHELD_LOCATION_M : 1e-6;
      expectNear(first.position, START.position, tol, `${move} start`);
      if (move !== 'handheld') expect(aim(first, START.target), `${move} start aim`).toBeLessThan(1e-4);
      expect(first.lens, move).toBeCloseTo(35, 9);
      if (r.end) {
        const last = viewAt(doc, cam, FE);
        expectNear(last.position, r.end.position, 1e-6, `${move} end`);
        expect(aim(last, r.end.target), `${move} end aim`).toBeLessThan(1e-3);
        expect(last.lens, move).toBeCloseTo(r.end.lens, 9);
      }
      expect(r.keyframes, move).toBeLessThanOrEqual(cameraMoveKeys(move, FE - FS + 1).keys);
      expect(r.keyframes, move).toBeGreaterThan(0);
    }
  });

  it("push, pull and dolly as rideo's moves: eased, the view kept (dolly: the target slides along)", () => {
    const ends: Partial<Record<DeskMove, number[]>> = {
      push_in: [0, 1.456, 1.385],
      pull_out: [0, 1.706, 2.877],
      dolly_left: [-1.5, 1.581, 2.131],
      dolly_right: [1.5, 1.581, 2.131],
    };
    for (const [move, end] of Object.entries(ends) as [DeskMove, number[]][]) {
      const { doc, cam } = setup();
      const r = applyCameraMove(doc, cam, move, { frame_start: FS, frame_end: FE, start: START });
      expectNear(rideo(viewAt(doc, cam, FE).position), end, 1.5e-3, move);
      // eased: half way at the middle frame, a little of the way a quarter in
      const mid = viewAt(doc, cam, (FS + FE) / 2).position;
      const half = START.position.map((p, i) => (p + r.end!.position[i]) / 2);
      expectNear(mid, half, 1e-3, `${move} middle`);
      const quarter = viewAt(doc, cam, FS + (FE - FS) / 4).position;
      const travelled = Math.hypot(...quarter.map((p, i) => p - START.position[i]));
      const total = Math.hypot(...r.end!.position.map((p, i) => p - START.position[i]));
      expect(travelled / total, move).toBeGreaterThan(0.1);
      expect(travelled / total, move).toBeLessThan(0.2);
      // the view direction stays
      expectNear(viewAt(doc, cam, FE).forward, viewAt(doc, cam, FS).forward, 1e-9, `${move} direction`);
      // only the location is keyed on a camera keyed nowhere else
      expect(keysIn(doc, cam, 'rotation_euler', 0), move).toEqual([]);
      expect(
        keysIn(doc, cam, 'location', 2).length + keysIn(doc, cam, 'location', 0).length,
        move,
      ).toBeGreaterThan(0);
    }
  });

  it('crane up and down while turning to keep the target framed', () => {
    for (const move of ['crane_up', 'crane_down'] as const) {
      const { doc, cam } = setup();
      applyCameraMove(doc, cam, move, { frame_start: FS, frame_end: FE, start: START });
      const sign = move === 'crane_up' ? 1 : -1;
      const last = viewAt(doc, cam, FE);
      expect(last.position[2], move).toBeCloseTo(Math.max(0.05, START.position[2] + 2 * sign), 6);
      for (const f of [FS, 13, 25, 37, FE]) {
        const p = projectPoint(viewAt(doc, cam, f), START.target);
        expect(Math.hypot(p.x, p.y), `${move} at ${f}`).toBeLessThan(0.03);
      }
    }
  });

  it('orbit around the target at its distance, keyed along the arc', () => {
    const golden = { orbit_left: [-1.065, 1.581, 1.846], orbit_right: [1.065, 1.581, 1.846] };
    for (const move of ['orbit_left', 'orbit_right'] as const) {
      const { doc, cam } = setup();
      applyCameraMove(doc, cam, move, { frame_start: FS, frame_end: FE, start: START });
      expectNear(rideo(viewAt(doc, cam, FE).position), golden[move], 1.5e-3, move);
      expect(keysIn(doc, cam, 'location', 0).length, move).toBeGreaterThanOrEqual(orbitKeyCount(1));
      expect(orbitKeyCount(1)).toBeGreaterThanOrEqual(8);
      const r0 = Math.hypot(START.position[0] - START.target[0], START.position[1] - START.target[1]);
      for (const f of keysIn(doc, cam, 'location', 0)) {
        const v = viewAt(doc, cam, f);
        expect(
          Math.hypot(v.position[0] - START.target[0], v.position[1] - START.target[1]),
          `${move} @${f}`,
        ).toBeCloseTo(r0, 6);
        expect(aim(v, START.target), `${move} aim @${f}`).toBeLessThan(1e-4);
      }
    }
    // a bigger turn keys more points
    expect(orbitKeyCount(3)).toBeGreaterThan(orbitKeyCount(1));
  });

  it('pan, tilt and whip by rotation only', () => {
    const turns: [DeskMove, number, number][] = [
      ['pan_left', PAN_DEG, 0],
      ['pan_right', -PAN_DEG, 0],
      ['tilt_up', 0, TILT_DEG],
      ['tilt_down', 0, -TILT_DEG],
    ];
    for (const [move, yaw, pitch] of turns) {
      const { doc, cam } = setup();
      applyCameraMove(doc, cam, move, { frame_start: FS, frame_end: FE, start: START });
      const a = viewAt(doc, cam, FS);
      const b = viewAt(doc, cam, FE);
      expectNear(b.position, a.position, 1e-9, move);
      expect(deg(heading(b) - heading(a)), move).toBeCloseTo(yaw, 6);
      expect(deg(Math.asin(b.forward[2]) - Math.asin(a.forward[2])), move).toBeCloseTo(pitch, 6);
      expect(keysIn(doc, cam, 'location', 0), move).toEqual([]);
    }
    // the whip turns 90° to the right in six frames around the middle of the shot
    const { doc, cam } = setup();
    applyCameraMove(doc, cam, 'whip_pan', { frame_start: FS, frame_end: FE, start: START });
    const mid = (FS + FE) / 2;
    const h0 = heading(viewAt(doc, cam, FS));
    expect(heading(viewAt(doc, cam, mid - WHIP_FRAMES / 2))).toBeCloseTo(h0, 9);
    expect(deg(heading(viewAt(doc, cam, mid + WHIP_FRAMES / 2)) - h0)).toBeCloseTo(-WHIP_DEG, 6);
    expect(deg(heading(viewAt(doc, cam, FE)) - h0)).toBeCloseTo(-WHIP_DEG, 6);
    const halfway = deg(heading(viewAt(doc, cam, mid)) - h0);
    expect(halfway).toBeLessThan(-30);
    expect(halfway).toBeGreaterThan(-60);
  });

  it('shake handheld with NOISE seeded by the shot: the same shot the same way, restricted to its range', () => {
    const shake = (seed: string) => {
      const { doc, cam } = setup();
      applyCameraMove(doc, cam, 'handheld', { frame_start: FS, frame_end: FE, start: START, seed });
      const noise = doc
        .listFCurves(cam)
        .flatMap((fc) => fc.modifiers ?? [])
        .filter((m) => m.type === 'NOISE');
      const path = Array.from({ length: FE - FS + 1 }, (_, i) => viewAt(doc, cam, FS + i).position);
      return { doc, cam, noise, path };
    };
    const a = shake('shot-a');
    expect(a.noise).toHaveLength(6);
    for (const m of a.noise)
      expect(m.params, 'restricted to the shot').toMatchObject({
        use_restricted_range: true,
        frame_start: FS,
        frame_end: FE,
      });
    expect(shake('shot-a').path).toEqual(a.path);
    const b = shake('shot-b');
    expect(b.path).not.toEqual(a.path);
    // it moves, but no more than a hand holds
    const offsets = a.path.map((p) => Math.hypot(...p.map((x, i) => x - START.position[i])));
    expect(Math.max(...offsets)).toBeGreaterThan(0.002);
    expect(Math.max(...offsets)).toBeLessThan(2 * HANDHELD_LOCATION_M);
    // outside the shot the camera holds still
    expectNear(viewAt(a.doc, a.cam, FE + 20).position, START.position, 1e-9, 'after the shot');
  });

  it('dolly zoom: the lens widens as the camera closes in, so the subject keeps its size', () => {
    const { doc, cam } = setup();
    const r = applyCameraMove(doc, cam, 'dolly_zoom', { frame_start: FS, frame_end: FE, start: START });
    expect(r.end!.lens).toBeCloseTo(35 * 0.65, 9);
    const d0 = Math.hypot(...START.target.map((t, i) => t - START.position[i]));
    for (const f of [FS, 13, 25, 37, FE]) {
      const v = viewAt(doc, cam, f);
      const d = Math.hypot(...START.target.map((t, i) => t - v.position[i]));
      expect(d / v.lens, `frame ${f}`).toBeCloseTo(d0 / 35, 6);
      expect(aim(v, START.target), `frame ${f}`).toBeLessThan(1e-6);
    }
  });

  it('fly a drone up over the subject, looking at it all the way', () => {
    const { doc, cam } = setup();
    const r = applyCameraMove(doc, cam, 'drone_flyover', { frame_start: FS, frame_end: FE, start: START });
    const last = viewAt(doc, cam, FE);
    expect(last.position[2] - START.position[2]).toBeCloseTo(DRONE_RISE_M, 6);
    const h0 = Math.hypot(START.position[0] - START.target[0], START.position[1] - START.target[1]);
    const h1 = Math.hypot(last.position[0] - START.target[0], last.position[1] - START.target[1]);
    expect(h1 / h0).toBeCloseTo(0.4, 6);
    expect(keysIn(doc, cam, 'location', 2)).toHaveLength(DRONE_KEYS);
    for (const f of keysIn(doc, cam, 'location', 2))
      expect(aim(viewAt(doc, cam, f), START.target)).toBeLessThan(1e-4);
    expect(r.end!.target).toEqual(START.target);
  });

  it('rack focus from the nearest subject to the farthest over the middle third', () => {
    const { doc, ada, ben, cam } = setup();
    applyCameraMove(doc, cam, 'rack_focus', {
      frame_start: FS,
      frame_end: FE,
      start: START,
      subjects: [ben, ada],
    });
    const data = doc.getCamera(doc.getObject(cam)!.data!)!;
    expect(data.dof_use).toBe(true);
    expect(data.dof_focus_object).toBeNull();
    const fc = doc.listFCurves(data.id).find((f) => f.path === 'dof_focus_distance')!;
    expect(fc.keyframes.map((k) => k.frame)).toEqual([FS, FS + 16, FS + 32, FE]);
    const [near, , far] = [fc.keyframes[0].value, 0, fc.keyframes[3].value];
    // Ada's chest is 2.131 m in front of the camera; Ben stands 3 m behind her
    expect(near).toBeCloseTo(
      Math.hypot(2.131, 1.581 - 0.72 * 1.7) * Math.cos(Math.atan2(1.581 - 1.224, 2.131)),
      1,
    );
    expect(far - near).toBeGreaterThan(2.5);
    expect(fc.keyframes[1].value).toBeCloseTo(near, 9);
    expect(fc.keyframes[2].value).toBeCloseTo(far, 9);
  });

  it('track the subject at a constant offset, or walk a steadicam behind its heading with a gentle bob', () => {
    const { doc, ada, cam } = setup();
    keyLocation(doc, ada, [
      [FS, [0, 0, 0]],
      [FE, [3, 0, 0]],
    ]);
    applyCameraMove(doc, cam, 'tracking_follow', {
      frame_start: FS,
      frame_end: FE,
      start: START,
      subject: ada,
    });
    expect(keysIn(doc, cam, 'location', 0)).toHaveLength(FE - FS + 1);
    for (const f of [FS, 20, FE]) {
      const v = viewAt(doc, cam, f);
      const x = (3 * (f - FS)) / (FE - FS);
      expectNear(
        v.position,
        [START.position[0] + x, START.position[1], START.position[2]],
        1e-6,
        `tracking @${f}`,
      );
      expectNear(v.forward, viewAt(doc, cam, FS).forward, 1e-9, `tracking view @${f}`);
    }

    const s = setup();
    keyHeading(s.doc, s.ada, [
      [FS, 0],
      [FE, 90],
    ]);
    applyCameraMove(s.doc, s.cam, 'steadicam_walk', {
      frame_start: FS,
      frame_end: FE,
      start: START,
      subject: s.ada,
    });
    const end = viewAt(s.doc, s.cam, FE);
    // Ada turned 90° to her left (+Z): the camera went round with her and still looks at her
    const r0 = Math.hypot(START.position[0], START.position[1]);
    expect(Math.hypot(end.position[0], end.position[1])).toBeCloseTo(r0, 6);
    expect(
      deg(Math.atan2(end.position[1], end.position[0]) - Math.atan2(START.position[1], START.position[0])),
    ).toBeCloseTo(90, 4);
    const bob = Array.from(
      { length: FE - FS + 1 },
      (_, i) => viewAt(s.doc, s.cam, FS + i).position[2] - START.position[2],
    );
    expect(Math.max(...bob.map(Math.abs))).toBeLessThanOrEqual(STEADICAM_BOB_M + 1e-9);
    expect(Math.max(...bob)).toBeGreaterThan(STEADICAM_BOB_M / 2);
  });

  it('lock off a camera keyed nowhere else as plain values', () => {
    const { doc, cam } = setup();
    applyCameraMove(doc, cam, 'push_in', { frame_start: FS, frame_end: FE, start: START });
    expect(keysIn(doc, cam, 'location', 2).length).toBeGreaterThan(0);
    // solving again without a move replaces the push: no keys left, the pose stored on the object
    const r = applyCameraMove(doc, cam, 'locked_off', { frame_start: FS, frame_end: FE, start: START });
    expect(r).toEqual({ keyframes: 0, end: null });
    expect(doc.listFCurves(cam).filter((fc) => fc.keyframes.length)).toEqual([]);
    expectNear(doc.getObject(cam)!.location, START.position, 1e-12, 'stored location');
    expect(aim(viewAt(doc, cam, 500), START.target)).toBeLessThan(1e-6);
  });

  it('replace only the keys of their own range on a camera that other shots share', () => {
    const { doc, cam } = setup();
    const shot = (frame_start: number, frame_end: number, move: DeskMove) =>
      applyCameraMove(doc, cam, move, { frame_start, frame_end, start: START, keyed: true });
    shot(1, 48, 'push_in');
    shot(49, 96, 'orbit_left');
    const other = doc.listFCurves(cam).map((fc) => fc.keyframes.filter((k) => k.frame >= 49));
    const orbitAt = (f: number) => viewAt(doc, cam, f).position;
    const before = [60, 72, 96].map(orbitAt);
    shot(1, 48, 'pull_out');
    expect(doc.listFCurves(cam).map((fc) => fc.keyframes.filter((k) => k.frame >= 49))).toEqual(other);
    expect([60, 72, 96].map(orbitAt)).toEqual(before);
    // the first shot now pulls out and holds its end until the second begins
    expectNear(rideo(viewAt(doc, cam, 48).position), [0, 1.706, 2.877], 1.5e-3, 'pulled out');
    expectNear(viewAt(doc, cam, 49).position, START.position, 1e-9, 'second shot');
    // clearing a range removes exactly its keys
    const removed = clearCameraRange(doc, cam, 1, 48);
    expect(removed).toBeGreaterThan(0);
    expect(doc.listFCurves(cam).every((fc) => fc.keyframes.every((k) => k.frame >= 49))).toBe(true);
  });

  it('follow a shot to a new range (retime) and prepare desk cameras', () => {
    const { doc, cam } = setup();
    applyCameraMove(doc, cam, 'handheld', { frame_start: FS, frame_end: FE, start: START, seed: 's' });
    applyCameraMove(doc, cam, 'push_in', { frame_start: FS, frame_end: FE, start: START });
    const mid = viewAt(doc, cam, 25).position;
    expect(retimeCameraRange(doc, cam, [FS, FE], [101, 197])).toBeGreaterThan(0);
    expect(keysIn(doc, cam, 'location', 1)).toEqual([101, 197]);
    expectNear(viewAt(doc, cam, 149).position, mid, 1e-9, 'stretched');
    expect(retimeCameraRange(doc, cam, [101, 197], [101, 197])).toBe(0);

    const c = addDeskCamera(doc, { name: 'Shot 9', shotId: 'shot9', lens: 50, at: [1, 2, 0] });
    const o = doc.getObject(c)!;
    expect(o.custom_props).toMatchObject({ desk_role: 'camera', desk_shot: 'shot9' });
    expect(doc.getCamera(o.data!)).toMatchObject({ lens: 50, sensor_fit: 'HORIZONTAL', sensor_width: 36 });
    expectNear(o.location, [1, -6, 1.6], 1e-12, 'eight metres in front, 1.6 m up');
    // a camera of the user's keeps its shot tag and gets the desk's sensor
    const mine = doc.addObject({
      type: 'CAMERA',
      name: 'Mine',
      data: doc.addCamera({ sensor_fit: 'AUTO', sensor_width: 24 }),
    });
    doc.updateObject(mine, { custom_props: { desk_shot: 'other' } });
    prepareDeskCamera(doc, mine, 'shot9');
    expect(doc.getObject(mine)!.custom_props).toMatchObject({ desk_role: 'camera', desk_shot: 'other' });
    expect(doc.getCamera(doc.getObject(mine)!.data!)).toMatchObject({
      sensor_fit: 'HORIZONTAL',
      sensor_width: 36,
    });
  });

  it('refuse objects that are not cameras', () => {
    const { doc, ada } = setup();
    expect(() => applyCameraMove(doc, ada, 'push_in', { frame_start: 1, frame_end: 10 })).toThrow(
      /not a camera/,
    );
  });
});
