import { describe, expect, it } from 'vitest';
import { deskScene } from './desk-physics-helpers';

/*
 * A pan or a tilt turns away from its subjects by design: desk.check asks its subjects to be in the
 * frame at its first frame only. A subject it brings into the frame instead (a tilt up to a kite
 * high on its string) is revealed: a warning (subject_revealed), not subject_out_of_frame; one in the
 * frame at neither end is still out of frame.
 */

function kiteUp(move: 'tilt_up' | 'pan_left') {
  const s = deskScene();
  s.doc.updateScene({ fps: 24, frame_start: 1, frame_end: 300 });
  s.run('desk.set_build', {});
  const ada = s.run('desk.actor_add', { kind: 'adult', name: 'Ada', location: [0, 0, 0] }).actor as string;
  const kite = s.run('store.add', { model: 'diamond_kite', name: 'Kite', location: [0.5, 0, 0] })
    .root as string;
  s.run('desk.tether_fly', {
    flyer: 'Kite',
    anchor: 'Ada',
    anchor_bone: 'hand.R',
    length_m: 12,
    wind_dir_deg: 180,
    wind_mps: 5,
    frame_start: 1,
    frame_end: 300,
  });
  s.run('desk.shot_add', {
    name: 'Kite Up',
    framing: 'medium',
    angle: 'three_quarter_left',
    height: 'low',
    subjects: [ada, kite],
    move,
    frame_start: 145,
    frame_end: 288,
  });
  const issues = s.run('desk.check', {}).issues as {
    code: string;
    severity: string;
    objects: string[];
    message: string;
  }[];
  return {
    kite,
    framing: issues.filter((i) => i.code === 'subject_out_of_frame' || i.code === 'subject_revealed'),
  };
}

describe('desk.check on pans and tilts', () => {
  it('takes a subject a tilt brings into the frame for revealed, a warning', () => {
    const { kite, framing } = kiteUp('tilt_up');
    expect(framing.map((i) => [i.code, i.severity, i.objects])).toEqual([
      ['subject_revealed', 'warning', [kite]],
    ]);
    expect(framing[0].message).toBe(
      "Kite comes into the frame of shot 'Kite Up' only as its tilt_up ends (out of it at frame 145, in it at " +
        'frame 288): the move reveals it; frame it from the start if it should be seen throughout',
    );
  });

  it('still says a subject in the frame at neither end is out of frame', () => {
    const { kite, framing } = kiteUp('pan_left');
    expect(framing.map((i) => [i.code, i.severity, i.objects])).toEqual([
      ['subject_out_of_frame', 'error', [kite]],
    ]);
    expect(framing[0].message).toBe("Kite is not in the frame of shot 'Kite Up' (frames 145, 288)");
  });
});
