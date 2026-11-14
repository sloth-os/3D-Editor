import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import { moveAlongPath } from '../src/desk/characters';
import { DESK_PROPS } from '../src/desk/props';
import { getShots } from '../src/desk/shots';
import { RIDEO_PROPS, exportRideoBlocking } from '../src/desk/rideo';
import { rideoHeightRatio } from '../src/desk/rideo/import';
import { meshWorldBounds } from '../src/store/builtin/kit';
import {
  LEO,
  MAYA,
  PEPPER,
  ROSIE,
  dialogueClip,
  importClip,
  kiteClip,
  ridingClip,
} from './desk-rideo-fixtures';

/*
 * A re-import of a rideo clip rebuilds the motion of the actors, props and shot cameras it imported
 * from rideo's blocking: what was staged on them in the desk since (an actor_move, a pose, a camera
 * solved again) is lost. It says so, naming them, so that an agent does not lose its staging
 * silently; unchanged objects are not named.
 */

const CHANGED = /changed in the desk since the last import/;
const changedWarnings = (warnings: readonly string[]) => warnings.filter((w) => CHANGED.test(w));

describe('rideo re-import over staging done in the desk', () => {
  it('says nothing when nothing imported was changed since', () => {
    const doc = SceneDoc.create({ empty: true });
    const first = importClip(doc, dialogueClip());
    const leo = first.actors.find((a) => a.character_id === LEO)!.id;
    expect(typeof doc.getObject(leo)!.custom_props?.[RIDEO_PROPS.motion]).toBe('string');
    expect(changedWarnings(importClip(doc, dialogueClip()).warnings)).toEqual([]);
    // twice in a row, from the digest the second import recorded
    expect(changedWarnings(importClip(doc, dialogueClip()).warnings)).toEqual([]);
  });

  it('names the actors moved and the cameras changed since, which it rebuilds from the blocking', () => {
    const doc = SceneDoc.create({ empty: true });
    const first = importClip(doc, dialogueClip());
    const leo = first.actors.find((a) => a.character_id === LEO)!;
    const maya = first.actors.find((a) => a.character_id === MAYA)!;
    // an agent walks Leo off and moves the first shot's camera
    moveAlongPath(doc, leo.id, [[2, -1, 0]], { frame_start: 20, speed_mps: 1.3 });
    const shot = getShots(doc)[0];
    const cam = doc.getObject(shot.camera!)!;
    doc.updateObject(cam.id, { location: [cam.location[0] + 1, cam.location[1], cam.location[2]] });
    const second = importClip(doc, dialogueClip());
    const [warning] = changedWarnings(second.warnings);
    expect(warning).toBeDefined();
    expect(warning).toContain(`'${doc.getObject(leo.id)!.name}'`);
    expect(warning).toContain(`the camera of shot '${shot.name}'`);
    expect(warning).not.toContain(`'${doc.getObject(maya.id)!.name}'`);
    expect(warning).toMatch(/were changed in the desk since the last import .*Stage them again/);
    // the re-import recorded what it left: a third import names nobody
    expect(changedWarnings(importClip(doc, dialogueClip()).warnings)).toEqual([]);
  });

  it('names a prop flown or keyed in the desk since', () => {
    const doc = SceneDoc.create({ empty: true });
    const first = importClip(doc, kiteClip());
    const kite = first.props[0];
    doc.updateObject(kite.id, { rotation_euler: [0, 0, 1] });
    const [warning] = changedWarnings(importClip(doc, kiteClip()).warnings);
    expect(warning).toMatch(new RegExp(`^'${doc.getObject(kite.id)!.name}' was changed in the desk`));
  });
});

describe("rideo's heights of animals", () => {
  it("makes a pony as tall as rideo's figure (its head, not its withers), and writes that height back", () => {
    const clip = ridingClip();
    const actors = (clip.blocking as { actors: { characterId: string; heightM: number }[] }).actors;
    actors.find((a) => a.characterId === PEPPER)!.heightM = 1.3;
    const doc = SceneDoc.create({ empty: true });
    const r = importClip(doc, clip);
    const pepper = r.actors.find((a) => a.character_id === PEPPER)!.id;
    const rosie = r.actors.find((a) => a.character_id === ROSIE)!.id;
    const top = (id: string) => {
      const parts = doc.listObjects().filter((o) => o.custom_props?.[DESK_PROPS.actor] === id);
      return meshWorldBounds(doc, [id, ...parts.map((o) => o.id)], 1)!.max[2];
    };
    // rideo draws the pony 1.3 m tall to the top of its head: the desk's pony too, its withers lower
    expect(top(pepper)).toBeCloseTo(1.3, 2);
    const ratio = rideoHeightRatio('pony');
    expect(ratio).toBeGreaterThan(1.2);
    expect(Number(doc.getObject(pepper)!.custom_props?.[DESK_PROPS.heightM])).toBeCloseTo(1.3 / ratio, 6);
    // a person's height is her figure's in both
    expect(rideoHeightRatio('child')).toBe(1);
    expect(top(rosie)).toBeCloseTo(1.3, 1);
    // exported as rideo has them, and the same pony again on a re-import
    const x = exportRideoBlocking(doc, { now: '2026-11-13T12:00:00.000Z' });
    const heights = new Map(x.blocking.actors.map((a) => [a.characterId, a.heightM]));
    expect([heights.get(PEPPER), heights.get(ROSIE)]).toEqual([1.3, 1.3]);
    const again = importClip(doc, { ...clip, blocking: x.blocking });
    expect(again.actors.map((a) => a.created)).toEqual([false, false]);
  });
});
