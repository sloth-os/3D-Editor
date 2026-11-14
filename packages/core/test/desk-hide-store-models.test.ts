import { describe, expect, it } from 'vitest';
import type { Mat4, Vec3 } from '../src/math/types';
import { FrameState } from '../src/eval/frame-state';
import { HIDDEN_SCALE_EPS, HIDE_SCALE, hiddenByScale, hiddenGeometry } from '../src/desk/hide';
import { DeskScene, projectPoint } from '../src/desk/layout';
import { getShots } from '../src/desk/shots';
import { deskScene } from './desk-physics-helpers';

/*
 * Store models shown at tiny scales: store.insert_files fits a model to its size by scaling its root,
 * so a model in very large native units, or one in millimetres made a toy, is shown at a world scale
 * of 1e-6 or 1e-5. The desk reads such a model as shown (not put away by a hide key: hide.ts), frames
 * it, and a hide key of desk.tether_fly shrinks it as much as any other (relative to the scale it is
 * shown at), not to an absolute scale that leaves a model in large units visible.
 */

/** An OBJ cube `size` native units across. */
function cubeObj(size: number): string {
  const s = size / 2;
  const height = size;
  const v: Vec3[] = [
    [-s, -s, 0],
    [s, -s, 0],
    [s, s, 0],
    [-s, s, 0],
    [-s, -s, height],
    [s, -s, height],
    [s, s, height],
    [-s, s, height],
  ];
  return (
    v.map((p) => `v ${p.join(' ')}`).join('\n') +
    '\nf 1 2 3 4\nf 5 8 7 6\nf 1 5 6 2\nf 2 6 7 3\nf 3 7 8 4\nf 4 8 5 1\n'
  );
}

/** store.insert_files of a cube model `units` native units across fitted to `height_m` metres. */
function insertBox(
  s: ReturnType<typeof deskScene>,
  units: number,
  height_m: number,
  location: Vec3,
): { root: string; name: string } {
  const r = s.run('store.insert_files', {
    entry: {
      id: `box${units}`,
      name: 'Crate',
      provider: 'test',
      license: { spdx: 'CC0-1.0', url: null, attribution: null },
      author: 'test',
      source_url: 'https://example.invalid/box',
      category: 'props',
    },
    format: 'obj',
    files: { 'box.obj': Buffer.from(cubeObj(units)).toString('base64') },
    main: 'box.obj',
    height_m,
    location,
  });
  return { root: r.root, name: s.doc.getObject(r.root)!.name };
}

const scaleOf = (m: Readonly<Mat4>) => Math.hypot(m[0], m[1], m[2]);

describe('store models shown at a tiny scale', () => {
  it.each([
    ['a model 1,000,000 units across made 1 m', 1e6, 1],
    ['a 1.5 m model in millimetres made a 2 cm toy', 1500, 0.02],
    // below HIDDEN_SCALE_EPS: a world matrix alone reads it as collapsed, its size does not
    ['a model 1,000,000 units across made 1 cm', 1e6, 0.01],
  ])('are shown, framed and checked as shown: %s', (_label, units, height) => {
    const s = deskScene();
    const { root } = insertBox(s, units, height, [0, 0, 0]);
    const shownScale = s.doc.getObject(root)!.scale[0];
    expect(shownScale).toBeCloseTo(height / units, 12);
    expect(shownScale).toBeLessThan(1e-4);
    const scene = new DeskScene(s.doc);
    expect(hiddenByScale(scene.world(root, 1))).toBe(shownScale < HIDDEN_SCALE_EPS);
    expect(scene.hidden(root, 1)).toBe(false);
    expect(scene.subject(root, 1)!.hidden).toBe(false);
    s.run('desk.actor_add', { kind: 'adult', name: 'Ada', location: [1.5, 0, 0] });
    s.run('desk.shot_add', {
      name: 'S1',
      framing: 'medium',
      angle: 'front',
      subjects: [root],
      duration_s: 2,
    });
    const shot = getShots(s.doc)[0];
    // the solver framed the model: its middle is in the picture at the shot's first and last frames
    const framed = new DeskScene(s.doc);
    for (const f of [shot.frame_start, shot.frame_end]) {
      const view = framed.camera(shot.camera!, f)!;
      const p = projectPoint(view, framed.subject(root, f)!.center);
      expect(Math.abs(p.x), `frame ${f}`).toBeLessThan(1);
      expect(Math.abs(p.y), `frame ${f}`).toBeLessThan(1);
    }
    const codes = (s.run('desk.check', {}).issues as { code: string }[]).map((i) => i.code);
    expect(codes).not.toContain('subject_hidden');
    expect(codes).not.toContain('subject_out_of_frame');
  });

  it.each([
    ['in very large units (1,000,000 across, shown 5 cm wide)', 1e6],
    ['in metres (1 across, shown 5 cm wide)', 1],
  ])('shrink to a point under a hide key of desk.tether_fly: %s', (_label, units) => {
    const s = deskScene();
    // a kite 5 cm across
    const { root, name } = insertBox(s, units, 0.05, [0.5, 0, 1.3]);
    const shown = s.doc.getObject(root)!.scale[0];
    expect(units * shown).toBeCloseTo(0.05, 9);
    s.empty('Hand', [0, 0, 1.2]);
    const r = s.run('desk.tether_fly', {
      flyer: name,
      anchor: 'Hand',
      length_m: 20,
      wind_dir_deg: 90,
      wind_mps: 6,
      frame_start: 1,
      frame_end: 24,
      after: 'hide',
    });
    expect(r.hidden_from).toBe(25);
    const before = new FrameState(s.doc, 24).world(root)!;
    const w = new FrameState(s.doc, 40).world(root)!;
    // a world matrix alone reads the model in large units as collapsed even when it is shown (at
    // 5e-8, below HIDDEN_SCALE_EPS); its geometry tells it shown, 5 cm across
    const half = units / 2;
    const geometry = (m: Mat4) => hiddenGeometry(m, [-half, -half, 0], [half, half, units]);
    expect([geometry(before), geometry(w)]).toEqual([false, true]);
    expect(hiddenByScale(w)).toBe(true);
    const scene = new DeskScene(s.doc);
    expect([scene.hidden(root, 24), scene.hidden(root, 40)]).toEqual([false, true]);
    // shrunk by HIDE_SCALE of the scale it was shown at, to far below a micrometre across
    expect(scaleOf(w) / scaleOf(before)).toBeCloseTo(HIDE_SCALE, 12);
    expect(units * scaleOf(w)).toBeLessThan(1e-6);
  });
});
