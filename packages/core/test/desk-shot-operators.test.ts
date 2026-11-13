import { describe, expect, it } from 'vitest';
import type { SceneDoc } from '../src/doc/scene-doc';
import type { ShotData } from '../src/doc/types';
import { estimateOperator } from '../src/operators';
import { DeskScene, type CameraView } from '../src/desk/layout';
import { getShots } from '../src/desk/shots';
import { lineSide } from '../src/desk/solver';
import { viewRoll } from '../src/desk/moves';
import { deskDoc, deskOperators, ed, expectNear, rideo, rideoCamera, standIn } from './desk-fixtures';

/*
 * The shot operators (operators/desk-shots.ts) run through the operator registry: defaults of a new
 * shot and its camera, updates and retiming, removal, the cut order, solving (the line, plans,
 * moves), the checks, the set and camera moves, each one undo step.
 */

/** Ada at x −0.8 and Ben (1.8 m) at x 0.8 facing each other; operators over the scene. */
function pair() {
  const doc = deskDoc();
  const A = standIn(doc, 'Ada', -0.8, 0, 90);
  const B = standIn(doc, 'Ben', 0.8, 0, 270, 1.8);
  return { doc, A, B, ...deskOperators(doc) };
}

const viewAt = (doc: SceneDoc, cam: string, frame: number): CameraView =>
  new DeskScene(doc).camera(cam, frame)!;
const shotNamed = (doc: SceneDoc, name: string): ShotData => getShots(doc).find((s) => s.name === name)!;

interface Added {
  shot: {
    id: string;
    name: string;
    camera: string;
    camera_name: string;
    frame_start: number;
    frame_end: number;
  };
  solved: boolean;
}

describe('desk.shot_add', () => {
  it('adds a shot after the last with a new desk camera named after it', () => {
    const { doc, run, ctx } = pair();
    const first = run<Added>('desk.shot_add');
    expect(first).toMatchObject({ shot: { name: 'Shot 1', frame_start: 1, frame_end: 120 }, solved: false });
    const cam = doc.getObject(first.shot.camera)!;
    expect(cam).toMatchObject({ type: 'CAMERA', name: 'Shot 1' });
    expect(cam.custom_props).toEqual({ desk_role: 'camera', desk_shot: first.shot.id });
    expect(doc.getCamera(cam.data!)).toMatchObject({ lens: 35, sensor_fit: 'HORIZONTAL', sensor_width: 36 });
    expect(doc.getScene().camera).toBe(cam.id);
    expect(ctx.state.selectedIds).toEqual([cam.id]);
    expect(ctx.state.activeId).toBe(cam.id);
    // the next one starts after it (and its pre-roll), 10 s long; the scene grows to hold it
    const second = run<Added>('desk.shot_add', { duration_s: 10, pre_roll: 12, name: 'Long' });
    expect(second.shot).toMatchObject({ name: 'Long', frame_start: 133, frame_end: 372 });
    expect(doc.getScene().frame_end).toBe(372);
    expect(doc.getScene().camera).toBe(cam.id);
    expect(getShots(doc).map((s) => s.name)).toEqual(['Shot 1', 'Long']);
    // a free name and a place in the cut
    const third = run<Added>('desk.shot_add', { index: 0 });
    expect(third.shot.name).toBe('Shot 3');
    expect(getShots(doc).map((s) => s.name)).toEqual(['Shot 3', 'Shot 1', 'Long']);
  });

  it("solves the camera from the shot's framing and subjects (rideo's wide two-shot)", () => {
    const { doc, A, B, run } = pair();
    const r = run<Added>('desk.shot_add', { framing: 'wide', subjects: ['Ada', 'Ben'] });
    expect(r.solved).toBe(true);
    const s = shotNamed(doc, 'Shot 1');
    expect(s.subjects).toEqual([A, B]);
    const v = viewAt(doc, r.shot.camera, 1);
    expectNear(rideo(v.position), [0, 1.674, 5.213], 1.5e-3, 'wide front');
    expect(v.lens).toBe(24);
    // a planned layout: the camera that shows Ada right, facing left, and Ben left (rideo: from the back)
    const planned = run<Added>('desk.shot_add', {
      framing: 'medium',
      subjects: ['Ada'],
      layout: [
        { subject: 'Ada', side: 'right', facing: 'left' },
        { subject: 'Ben', side: 'left', facing: 'right' },
      ],
    });
    expect(shotNamed(doc, 'Shot 2')).toMatchObject({ subjects: [A, B], angle: 'back' });
    expectNear(
      rideo(viewAt(doc, planned.shot.camera, planned.shot.frame_start).position),
      [0, 1.674, -2.256],
      1.5e-3,
      'back',
    );
  });

  it('places the camera at a given view, or shoots with an existing camera', () => {
    const { doc, A, run } = pair();
    const r = run<Added>('desk.shot_add', {
      subjects: ['Ada'],
      move: 'push_in',
      from_view: { position: [1, -6, 2], target: [0, 0, 1], lens_mm: 40 },
    });
    expect(r.solved).toBe(false);
    const v = viewAt(doc, r.shot.camera, 1);
    expectNear(v.position, [1, -6, 2], 1e-9, 'from the view');
    expect(v.lens).toBe(40);
    // the push is keyed from there
    const end = viewAt(doc, r.shot.camera, 120).position;
    expect(Math.hypot(end[0] - 1, end[1] + 6, end[2] - 2)).toBeGreaterThan(0.5);
    const mine = rideoCamera(doc, 'Mine', [0, 1.6, 6], [0, 1, 0], 50);
    const objects = doc.listObjects().length;
    const s = run<Added>('desk.shot_add', { camera: 'Mine', subjects: [A], solve: false });
    expect(s.shot.camera).toBe(mine);
    expect(doc.listObjects().length).toBe(objects);
  });

  it("keeps the first shot's view when a second shot shoots with its camera", () => {
    const { doc, A, run } = pair();
    const a = run<Added>('desk.shot_add', {
      name: 'A',
      subjects: ['Ada', 'Ben'],
      framing: 'wide',
      frame_start: 1,
      frame_end: 48,
    });
    const cam = a.shot.camera;
    // alone on its camera, A's pose is stored as plain values (no keys)
    expect(doc.listFCurves(cam).filter((fc) => fc.keyframes.length)).toEqual([]);
    const wide = (f: number) => {
      const v = viewAt(doc, cam, f);
      expectNear(rideo(v.position), [0, 1.674, 5.213], 1.5e-3, `A at frame ${f}`);
      expect(v.lens, `A lens at frame ${f}`).toBeCloseTo(24, 9);
    };
    [1, 24, 48].forEach(wide);
    run('desk.shot_add', {
      name: 'B',
      camera: cam,
      subjects: [A],
      framing: 'close_up',
      frame_start: 49,
      frame_end: 96,
    });
    [1, 24, 48].forEach(wide);
    expectNear(rideo(viewAt(doc, cam, 70).position), [0.747, 1.581, 1.083], 1.5e-3, 'B');
    expect(viewAt(doc, cam, 70).lens).toBeCloseTo(85, 9);
    expect(run<{ issues: unknown[] }>('desk.check').issues).toEqual([]);
    // solving B again, and a move keyed on a later range of the camera, leave A alone too
    run('desk.shot_solve', { shots: ['B'] });
    run('desk.camera_move', { camera: cam, move: 'crane_up', frame_start: 150, frame_end: 180 });
    [1, 24, 48].forEach(wide);
  });

  it('refuses a shot over the range of another shot on the same camera', () => {
    const { reg, ctx, run } = pair();
    const a = run<Added>('desk.shot_add', { name: 'A', subjects: ['Ada'], frame_start: 1, frame_end: 48 });
    expect(
      reg.run(ctx, 'desk.shot_add', { name: 'B', camera: a.shot.camera, frame_start: 40, frame_end: 80 }),
    ).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
  });

  it('refuses bad ranges, unknown subjects and non-camera objects', () => {
    const { reg, ctx } = pair();
    expect(reg.run(ctx, 'desk.shot_add', { frame_start: 50, frame_end: 10 })).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS',
    });
    expect(reg.run(ctx, 'desk.shot_add', { subjects: ['Nobody'] })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(reg.run(ctx, 'desk.shot_add', { camera: 'Ada' })).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS',
    });
  });

  it('is one undo step with its camera', () => {
    const { doc, run, undo } = pair();
    const objects = doc.listObjects().length;
    run('desk.shot_add', { framing: 'medium', subjects: ['Ada'], move: 'orbit_left' });
    expect(getShots(doc)).toHaveLength(1);
    expect(doc.listObjects().length).toBe(objects + 1);
    undo.undo();
    expect(getShots(doc)).toEqual([]);
    expect(doc.listObjects().length).toBe(objects);
    undo.redo();
    expect(getShots(doc)).toHaveLength(1);
  });
});

describe('desk.shot_update, shot_remove and shot_move', () => {
  it('moves a shot keeping its length and its camera move with it', () => {
    const { doc, run } = pair();
    const r = run<Added>('desk.shot_add', { framing: 'medium', subjects: ['Ada'], move: 'push_in' });
    const mid = viewAt(doc, r.shot.camera, 60).position;
    const u = run<{ shot: { frame_start: number; frame_end: number }; solved: boolean }>('desk.shot_update', {
      shot: 'Shot 1',
      frame_start: 201,
    });
    expect(u).toMatchObject({ shot: { frame_start: 201, frame_end: 320 }, solved: false });
    expectNear(viewAt(doc, r.shot.camera, 260).position, mid, 1e-9, 'the push moved with the shot');
    expect(doc.getScene().frame_end).toBe(320);
    // a duration sets the end
    expect(
      run<{ shot: { frame_end: number } }>('desk.shot_update', { shot: 'Shot 1', duration_s: 2 }).shot
        .frame_end,
    ).toBe(248);
  });

  it('refuses to move a shot onto another shot of its camera, and keeps the other shot when moved elsewhere', () => {
    const { doc, reg, ctx, run } = pair();
    const a = run<Added>('desk.shot_add', {
      name: 'A',
      subjects: ['Ada', 'Ben'],
      framing: 'wide',
      move: 'push_in',
      frame_start: 1,
      frame_end: 48,
    });
    const cam = a.shot.camera;
    run('desk.shot_add', {
      name: 'B',
      camera: cam,
      subjects: ['Ada'],
      framing: 'close_up',
      move: 'orbit_left',
      frame_start: 49,
      frame_end: 96,
    });
    const orbit = [49, 60, 72, 96].map((f) => viewAt(doc, cam, f).position);
    const keys = doc.listFCurves(cam).map((fc) => fc.keyframes.length);
    const r = reg.run(ctx, 'desk.shot_update', { shot: 'A', frame_start: 60, resolve: false });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(r.ok ? '' : r.error).toMatch(
      /would overlap shot 'B' \(frames 49–96\), which shoots with the same camera/,
    );
    expect(doc.listFCurves(cam).map((fc) => fc.keyframes.length)).toEqual(keys);
    // a range of its own: B's orbit stays
    run('desk.shot_update', { shot: 'A', frame_start: 101, resolve: false });
    [49, 60, 72, 96].forEach((f, i) => expectNear(viewAt(doc, cam, f).position, orbit[i], 1e-9, `B at ${f}`));
    // a camera another shot already uses over the range is refused too
    const c = run<Added>('desk.shot_add', { name: 'C', subjects: ['Ben'], frame_start: 49, frame_end: 96 });
    expect(reg.run(ctx, 'desk.shot_update', { shot: 'C', camera: cam })).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS',
    });
    expect(shotNamed(doc, 'C').camera).toBe(c.shot.camera);
  });

  it('keeps the view of a shot without keys of its own when the shot keyed before it moves away', () => {
    const { doc, run } = pair();
    const a = run<Added>('desk.shot_add', {
      name: 'A',
      subjects: ['Ada', 'Ben'],
      framing: 'wide',
      move: 'push_in',
      frame_start: 1,
      frame_end: 48,
    });
    const cam = a.shot.camera;
    // B shows the camera as A leaves it (A's last key held)
    run('desk.shot_add', {
      name: 'B',
      camera: cam,
      subjects: ['Ada'],
      frame_start: 49,
      frame_end: 96,
      solve: false,
    });
    const frames = [49, 72, 96];
    const before = frames.map((f) => viewAt(doc, cam, f));
    const push = [1, 24, 48].map((f) => viewAt(doc, cam, f).position);
    expect(push[0][1]).not.toBeCloseTo(push[2][1], 3);
    run('desk.shot_update', { shot: 'A', frame_start: 101, resolve: false });
    frames.forEach((f, i) => {
      const v = viewAt(doc, cam, f);
      expectNear(v.position, before[i].position, 1e-9, `B at ${f}`);
      expectNear(v.forward, before[i].forward, 1e-9, `B looks at ${f}`);
    });
    // A took its push with it
    [101, 124, 148].forEach((f, i) => expectNear(viewAt(doc, cam, f).position, push[i], 1e-9, `A at ${f}`));
  });

  it('leaves no keys behind when a moved shot is solved again', () => {
    const { doc, run } = pair();
    const r = run<Added>('desk.shot_add', { framing: 'medium', subjects: ['Ada'], move: 'push_in' });
    run('desk.shot_update', { shot: 'Shot 1', frame_start: 301, framing: 'close_up' });
    const frames = doc.listFCurves(r.shot.camera).flatMap((fc) => fc.keyframes.map((k) => k.frame));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f >= 301 && f <= 420)).toBe(true);
  });

  it('solves the camera again when its spec changes, unless told not to', () => {
    const { doc, run } = pair();
    const r = run<Added>('desk.shot_add', { framing: 'medium', subjects: ['Ada'] });
    const before = viewAt(doc, r.shot.camera, 1).position;
    expect(
      run<{ solved: boolean }>('desk.shot_update', { shot: 'Shot 1', framing: 'close_up', resolve: false })
        .solved,
    ).toBe(false);
    expectNear(viewAt(doc, r.shot.camera, 1).position, before, 1e-12, 'kept');
    expect(run<{ solved: boolean }>('desk.shot_update', { shot: 'Shot 1', framing: 'wide' }).solved).toBe(
      true,
    );
    expect(viewAt(doc, r.shot.camera, 1).lens).toBe(24);
    // notes and names do not move the camera
    const now = viewAt(doc, r.shot.camera, 1).position;
    expect(
      run<{ solved: boolean }>('desk.shot_update', { shot: 'Shot 1', name: 'Opening', notes: 'Ada waits' })
        .solved,
    ).toBe(false);
    expectNear(viewAt(doc, r.shot.camera, 1).position, now, 1e-12, 'unchanged');
    // the camera can be taken away without a new one appearing
    const objects = doc.listObjects().length;
    run('desk.shot_update', { shot: 'Opening', camera: null });
    expect(shotNamed(doc, 'Opening').camera).toBeNull();
    expect(doc.listObjects().length).toBe(objects);
  });

  it('removes shots and the cameras no other shot uses', () => {
    const { doc, run, reg, ctx } = pair();
    const a = run<Added>('desk.shot_add', { subjects: ['Ada'] });
    run<Added>('desk.shot_add', { camera: a.shot.camera, subjects: ['Ada'], solve: false });
    const c = run<Added>('desk.shot_add', { subjects: ['Ben'] });
    ctx.state.selectedIds = [c.shot.camera];
    ctx.state.activeId = c.shot.camera;
    const r = run<{ removed: { name: string }[]; deleted_cameras: string[] }>('desk.shot_remove', {
      shots: ['Shot 1', 'Shot 3'],
      delete_cameras: true,
    });
    expect(r.removed.map((x) => x.name)).toEqual(['Shot 1', 'Shot 3']);
    // Shot 2 still shoots with the first camera
    expect(r.deleted_cameras).toEqual([c.shot.camera]);
    expect(doc.getObject(a.shot.camera)).not.toBeNull();
    expect(ctx.state.selectedIds).toEqual([]);
    expect(ctx.state.activeId).toBeNull();
    expect(getShots(doc).map((s) => s.name)).toEqual(['Shot 2']);
    expect(reg.run(ctx, 'desk.shot_remove', { shots: ['Shot 9'] })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });
  });

  it('moves a shot in the cut', () => {
    const { run } = pair();
    for (let i = 0; i < 3; i++) run('desk.shot_add');
    expect(
      run<{ order: { name: string }[] }>('desk.shot_move', { shot: 'Shot 3', index: 0 }).order.map(
        (s) => s.name,
      ),
    ).toEqual(['Shot 3', 'Shot 1', 'Shot 2']);
    expect(
      run<{ order: { name: string }[] }>('desk.shot_move', { shot: 'Shot 3', index: 99 }).order.map(
        (s) => s.name,
      ),
    ).toEqual(['Shot 1', 'Shot 2', 'Shot 3']);
  });
});

describe('desk.shot_solve', () => {
  it('keeps the cameras on one side of the line, mirrors crossed ones and reports the issues', () => {
    const { doc, A, B, run } = pair();
    run('desk.shot_add', { framing: 'wide', subjects: ['Ada', 'Ben'] });
    // a close-up of Ada from her left: the far side of the line
    run('desk.shot_add', {
      framing: 'close_up',
      angle: 'three_quarter_left',
      subjects: ['Ada'],
      solve: false,
    });
    const r = run<{ shots: { name: string; created: boolean }[]; issues: { code: string }[] }>(
      'desk.shot_solve',
    );
    expect(r.shots.map((s) => s.name)).toEqual(['Shot 1', 'Shot 2']);
    expect(r.issues.filter((i) => i.code === 'line_crossed')).toEqual([]);
    const scene = new DeskScene(doc);
    const a = scene.subject(A, 1)!.feet;
    const b = scene.subject(B, 1)!.feet;
    const side = (name: string) =>
      lineSide(a, b, viewAt(doc, shotNamed(doc, name).camera!, shotNamed(doc, name).frame_start).position);
    expect(side('Shot 2')).toBe(side('Shot 1'));
    // a camera moved by hand across the line is flagged, and solving the shot again brings it back
    const cam2 = shotNamed(doc, 'Shot 2').camera!;
    doc.updateObject(cam2, { location: ed(0.747, 1.581, -1.083) });
    expect(run<{ issues: { code: string }[] }>('desk.check').issues.map((i) => i.code)).toContain(
      'line_crossed',
    );
    run('desk.shot_solve', { shots: ['Shot 2'] });
    expect(side('Shot 2')).toBe(side('Shot 1'));
    expect(run<{ issues: { code: string }[] }>('desk.check').issues.map((i) => i.code)).not.toContain(
      'line_crossed',
    );
  });

  it("solves a cut that opens over a shoulder as rideo's normalizeBlocking does (the front of the set)", () => {
    const { doc, run } = pair();
    run('desk.shot_add', {
      name: 'OTS Ben',
      subjects: ['Ben', 'Ada'],
      framing: 'over_shoulder',
      solve: false,
    });
    run('desk.shot_add', { name: 'Wide', subjects: ['Ada', 'Ben'], framing: 'wide', solve: false });
    run('desk.shot_add', { name: 'Ada CU', subjects: ['Ada'], framing: 'close_up', solve: false });
    run('desk.shot_solve');
    // rideo: the line of the shots placed so far and the one being solved, the first on the front side
    const golden: Record<string, { pos: number[]; target: number[]; lens: number }> = {
      'OTS Ben': { pos: [1.382, 1.548, 0.339], target: [-0.8, 1.581, 0], lens: 50 },
      Wide: { pos: [0, 1.674, 5.213], target: [0, 0.9, 0], lens: 24 },
      'Ada CU': { pos: [0.747, 1.581, 1.083], target: [-0.8, 1.564, 0], lens: 85 },
    };
    for (const [name, g] of Object.entries(golden)) {
      const s = shotNamed(doc, name);
      const v = viewAt(doc, s.camera!, s.frame_start);
      expectNear(rideo(v.position), g.pos, 1.5e-3, name);
      expect(v.lens, name).toBe(g.lens);
      const t = ed(g.target[0], g.target[1], g.target[2]);
      const d = t.map((x, i) => x - v.position[i]);
      const along = d.reduce((n, x, i) => n + x * v.forward[i], 0) / Math.hypot(...d);
      expect(along, `${name} looks at rideo's target`).toBeGreaterThan(1 - 1e-6);
    }
  });

  it('adds cameras for shots without one (only those with only_missing) and keeps lenses on request', () => {
    const { doc, run } = pair();
    const a = run<Added>('desk.shot_add', { framing: 'medium', subjects: ['Ada'] });
    run('desk.shot_update', { shot: 'Shot 1', camera: null });
    const b = run<Added>('desk.shot_add', { framing: 'medium', subjects: ['Ben'] });
    const before = viewAt(doc, b.shot.camera, b.shot.frame_start).position;
    const r = run<{ shots: { name: string; created: boolean }[] }>('desk.shot_solve', { only_missing: true });
    expect(r.shots).toEqual([expect.objectContaining({ name: 'Shot 1', created: true })]);
    expect(shotNamed(doc, 'Shot 1').camera).not.toBe(a.shot.camera);
    expectNear(viewAt(doc, b.shot.camera, b.shot.frame_start).position, before, 1e-12, 'Shot 2 untouched');
    // keep_lens: a camera at 70 mm keeps it
    doc.updateCamera(doc.getObject(b.shot.camera)!.data!, { lens: 70 });
    run('desk.shot_solve', { shots: ['Shot 2'], keep_lens: true });
    expect(viewAt(doc, b.shot.camera, b.shot.frame_start).lens).toBe(70);
    run('desk.shot_solve', { shots: ['Shot 2'] });
    expect(viewAt(doc, b.shot.camera, b.shot.frame_start).lens).toBe(35);
  });

  it('warns when no camera meets a plan, and is one undo step', () => {
    const { doc, run, reports, undo } = pair();
    run('desk.shot_add', {
      framing: 'medium',
      subjects: ['Ada', 'Ben'],
      // they face each other: no camera sees both facing it
      layout: [
        { subject: 'Ada', side: 'left', facing: 'camera' },
        { subject: 'Ben', side: 'right', facing: 'camera' },
      ],
      solve: false,
    });
    const cam = shotNamed(doc, 'Shot 1').camera!;
    const before = viewAt(doc, cam, 1).position;
    const r = run<{ shots: { agrees: boolean; refit: boolean }[]; issues: { code: string }[] }>(
      'desk.shot_solve',
    );
    expect(r.shots[0]).toMatchObject({ agrees: false });
    expect(reports.filter((x) => x.level === 'WARNING').map((x) => x.message)).toEqual([
      "The camera of shot 'Shot 1' disagrees with its planned layout (plan_mismatch)",
    ]);
    expect(r.issues.map((i) => i.code)).toEqual(['plan_mismatch']);
    expect(viewAt(doc, cam, 1).position).not.toEqual(before);
    undo.undo();
    expectNear(viewAt(doc, cam, 1).position, before, 1e-12, 'undone');
  });
});

describe('desk.check, desk.set_build and desk.camera_move', () => {
  it('checks the shots, any mode, by id or name', () => {
    const { run, reg, ctx } = pair();
    run('desk.shot_add', { framing: 'wide', subjects: ['Ada', 'Ben'] });
    run('desk.shot_add');
    ctx.state.mode = 'EDIT';
    const r = run<{
      issues: { code: string }[];
      lines: { line: string }[];
      layouts: unknown[];
      summary: string;
    }>('desk.check');
    // Shot 2 has no subjects, and its new camera (8 m in front of the cursor) sees Ada and Ben
    expect(r.issues.map((i) => i.code).sort()).toEqual(['absent_in_frame', 'absent_in_frame', 'empty_shot']);
    expect(r.lines[0].line).toMatch(/^Blocking: Ada is /);
    expect(r.lines[1].line).toBe('');
    expect(r.layouts).toHaveLength(2);
    expect(r.summary).toBe('2 shots checked: 0 errors, 3 warnings, 0 info (empty_shot, absent_in_frame)');
    expect(run<{ issues: unknown[] }>('desk.check', { shots: ['Shot 1'] }).issues).toEqual([]);
    expect(reg.run(ctx, 'desk.check', { shots: ['Shot 7'] })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('builds the set, warning about lights that compete with its key light', () => {
    const { doc, run, reports } = pair();
    const r = run<{ ground_name: string; walls: string[]; sun: string | null }>('desk.set_build', {
      interior: true,
    });
    expect(r).toMatchObject({ ground_name: 'Set Ground', sun: null });
    expect(r.walls).toHaveLength(4);
    expect(reports).toEqual([]);
    doc.addObject({ type: 'LIGHT', name: 'Fill', data: doc.addLight({ type: 'POINT' }) });
    run('desk.set_build', { sky: false });
    expect(reports.map((x) => x.message)).toEqual([
      "A light besides the set's sun lamp lights the set: Fill (hide them in renders for one key light)",
    ]);
  });

  it("keys a move on a shot's camera over its range, or on any camera over any range", () => {
    const { doc, run, reg, ctx } = pair();
    const r = run<Added>('desk.shot_add', { framing: 'medium', subjects: ['Ada'] });
    const m = run<{ keyframes: number; frame_start: number; frame_end: number; end: { position: number[] } }>(
      'desk.camera_move',
      { shot: 'Shot 1', move: 'dolly_right' },
    );
    expect(m).toMatchObject({ frame_start: 1, frame_end: 120 });
    expect(m.keyframes).toBeGreaterThan(0);
    expect(shotNamed(doc, 'Shot 1').move).toBe('dolly_right');
    expectNear(viewAt(doc, r.shot.camera, 120).position, m.end.position, 1e-9, 'end');
    // half the amount, part of the range: the shot's move stays
    const half = run<{ end: { position: number[] } }>('desk.camera_move', {
      camera: r.shot.camera,
      move: 'crane_up',
      frame_start: 10,
      frame_end: 30,
      amount: 0.5,
    });
    expect(half.end.position[2] - viewAt(doc, r.shot.camera, 10).position[2]).toBeCloseTo(1, 6);
    expect(shotNamed(doc, 'Shot 1').move).toBe('dolly_right');
    run('desk.shot_update', { shot: 'Shot 1', camera: null });
    expect(reg.run(ctx, 'desk.camera_move', { shot: 'Shot 1', move: 'push_in' })).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS',
    });
    expect(reg.run(ctx, 'desk.camera_move', { move: 'push_in' })).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS',
    });
    expect(reg.run(ctx, 'desk.camera_move', { camera: 'Ada', move: 'push_in' })).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS',
    });
  });
});

describe('camera moves on cameras placed by hand', () => {
  it("keep a dutch camera's roll, from its start and along an orbit", () => {
    const { doc, run } = pair();
    const cam = doc.addObject({
      type: 'CAMERA',
      name: 'Dutch',
      data: doc.addCamera({ name: 'Dutch', lens: 35, sensor_fit: 'HORIZONTAL', sensor_width: 36 }),
      location: [0, -5, 1.6],
      rotation_euler: [Math.PI / 2, 0.3, 0],
    });
    const before = viewAt(doc, cam, 1);
    const roll = viewRoll(before);
    expect(Math.abs(roll)).toBeCloseTo(0.3, 9);
    run('desk.camera_move', { camera: 'Dutch', move: 'push_in', frame_start: 1, frame_end: 48 });
    expectNear(viewAt(doc, cam, 1).up, before.up, 1e-9, 'up at the start');
    expect(viewRoll(viewAt(doc, cam, 48))).toBeCloseTo(roll, 9);
    run('desk.camera_move', { camera: 'Dutch', move: 'orbit_left', frame_start: 60, frame_end: 120 });
    for (const f of [60, 75, 90, 120])
      expect(viewRoll(viewAt(doc, cam, f)), `frame ${f}`).toBeCloseTo(roll, 6);
  });

  it('turn the depth of field rack_focus turned on off again with the rack, and leave one the user set', () => {
    const { doc, run } = pair();
    standIn(doc, 'Cy', 0.8, 2, 270);
    const r = run<Added>('desk.shot_add', { subjects: ['Ada', 'Cy'], framing: 'medium', move: 'rack_focus' });
    const data = () => doc.getCamera(doc.getObject(r.shot.camera)!.data!)!;
    const focusKeys = () =>
      doc.listFCurves(doc.getObject(r.shot.camera)!.data!).filter((fc) => fc.path === 'dof_focus_distance');
    expect(data().dof_use).toBe(true);
    expect(focusKeys()[0]?.keyframes.length).toBeGreaterThan(0);
    run('desk.shot_update', { shot: 'Shot 1', move: 'push_in' });
    expect(focusKeys()).toEqual([]);
    expect(data().dof_use).toBe(false);
    // the user's own depth of field stays on
    doc.updateCamera(doc.getObject(r.shot.camera)!.data!, { dof_use: true });
    run('desk.shot_update', { shot: 'Shot 1', move: 'rack_focus' });
    run('desk.shot_update', { shot: 'Shot 1', move: 'locked_off' });
    expect(data().dof_use).toBe(true);
  });
});

describe('estimates of the shot operators', () => {
  it('count the keys a move writes (every frame for a follow move) and the objects a set adds', () => {
    const { doc, run, reg, ctx } = pair();
    const estimate = (id: string, params: Record<string, unknown>) =>
      estimateOperator(id, ctx, reg.parseParams(id, params))!;
    for (const move of ['push_in', 'orbit_left', 'steadicam_walk', 'handheld'] as const) {
      const before = doc.listFCurves().reduce((n, fc) => n + fc.keyframes.length, 0);
      const params = { framing: 'medium', subjects: ['Ada'], move, duration_s: 4 };
      const e = estimate('desk.shot_add', params);
      run('desk.shot_add', params);
      const written = doc.listFCurves().reduce((n, fc) => n + fc.keyframes.length, 0) - before;
      expect(e.keyframes, move).toBeGreaterThanOrEqual(written);
      // an upper bound (a camera shared with other shots keys every channel), not far above
      expect(e.keyframes, move).toBeLessThanOrEqual(4 * written + 16);
      expect(e.objects, move).toBe(1);
    }
    // a shot on a camera other shots use keys their views too: still an upper bound
    const shared = run<Added>('desk.shot_add', { framing: 'wide', subjects: ['Ada', 'Ben'], duration_s: 2 });
    for (let i = 0; i < 3; i++) {
      const params = { camera: shared.shot.camera, framing: 'close_up', subjects: ['Ada'], duration_s: 2 };
      const e = estimate('desk.shot_add', params);
      const before = doc.listFCurves().reduce((n, fc) => n + fc.keyframes.length, 0);
      run('desk.shot_add', params);
      const written = doc.listFCurves().reduce((n, fc) => n + fc.keyframes.length, 0) - before;
      expect(e.keyframes, `shared ${i}`).toBeGreaterThanOrEqual(written);
    }
    // a follow move keys every frame: twice the frames, twice the keys
    const follow = (s: number) =>
      estimate('desk.shot_add', { move: 'tracking_follow', duration_s: s }).keyframes ?? 0;
    expect(follow(20) - follow(10)).toBeGreaterThan(3 * 10 * 24 - 1);
    for (const [params, objects] of [
      [{}, 1],
      [{ interior: true }, 5],
      [{ interior: true, sky: false }, 6],
    ] as const) {
      const d = deskDoc();
      const ops = deskOperators(d);
      const e = estimateOperator('desk.set_build', ops.ctx, ops.reg.parseParams('desk.set_build', params))!;
      const n = d.listObjects().length;
      ops.run('desk.set_build', params);
      expect(e.objects, JSON.stringify(params)).toBe(objects);
      expect(d.listObjects().length - n, JSON.stringify(params)).toBe(objects);
    }
  });
});
