import { describe, expect, it } from 'vitest';
import { deskScene } from './desk-physics-helpers';

/*
 * desk.physics_throw of a prop an actor holds: the preset launches the prop from the hand, but keys
 * no throw on the arm. It names the thrower (thrown_by) and says how to key the throw (a 'throw'
 * pose at the release, then the throw again from the throwing hand), and how to let go at the throw
 * when the hold goes on after it.
 */

function benWithBall() {
  const s = deskScene();
  s.run('desk.set_build', {});
  s.run('desk.actor_add', { kind: 'adult', name: 'Ben', location: [0, 0, 0] });
  s.run('store.add', { model: 'soccer_ball', name: 'Ball', location: [0.4, -0.2, 1] });
  return s;
}

const THROW = { object: 'Ball', target: [6, -4, 0], frame: 60, flight_s: 1.2 };

describe('desk.physics_throw of a held prop', () => {
  it('names the thrower and says how to key the throw on the arm', () => {
    const s = benWithBall();
    s.run('desk.actor_hold', { actor: 'Ben', prop: 'Ball', hand: 'right', frame: 1, release_frame: 60 });
    s.warnings.length = 0;
    const r = s.run('desk.physics_throw', THROW);
    expect(r.thrown_by).toMatchObject({ name: 'Ben' });
    const hint = s.warnings.filter((w) => w.includes('nothing keys the throw'));
    expect(hint).toEqual([
      "'Ball' leaves Ben's hand.R at frame 60, but nothing keys the throw: unless Ben already throws there, " +
        "pose it (desk.actor_pose {actor: 'Ben', pose: 'throw', frame: 60, layer: 'upper'}) and run " +
        'desk.physics_throw again, so that it leaves from the throwing hand.',
    ]);
  });

  it('says to let go at the throw when the hand holds on after it', () => {
    const s = benWithBall();
    s.run('desk.actor_hold', { actor: 'Ben', prop: 'Ball', hand: 'right', frame: 1, release_frame: 120 });
    s.warnings.length = 0;
    s.run('desk.physics_throw', THROW);
    const [hint] = s.warnings.filter((w) => w.includes('nothing keys the throw'));
    expect(hint).toMatch(
      /Ben holds it on until frame 120: let go at the throw \(desk\.actor_hold release_frame: 60\) so that the arm comes down\.$/,
    );
  });

  it('says nothing of a throw from no hand', () => {
    const s = benWithBall();
    s.warnings.length = 0;
    const r = s.run('desk.physics_throw', THROW);
    expect(r.thrown_by).toBeNull();
    expect(s.warnings.filter((w) => w.includes('nothing keys the throw'))).toEqual([]);
  });
});
