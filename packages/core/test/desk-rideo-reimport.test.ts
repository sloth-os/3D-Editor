import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import type { ShotData } from '../src/doc/types';
import { moveAlongPath } from '../src/desk/characters';
import { DESK_PROPS } from '../src/desk/props';
import { getShots } from '../src/desk/shots';
import { RIDEO_PROPS, exportRideoBlocking } from '../src/desk/rideo';
import { rideoHeightRatio } from '../src/desk/rideo/import';
import { FrameState } from '../src/eval/frame-state';
import type { Mat4, Vec3 } from '../src/math/types';
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
  worldAt,
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

/*
 * A shot camera the person hung from another object, which a re-import places as rideo blocked it:
 * through the parent's space when that stands still through the shot, else taken off the parent.
 */

/** The kite clip with its kite drawn and described as a balloon (a prop built anew, flown again). */
function balloonClip() {
  const clip = kiteClip();
  (clip.blocking as { props: { label: string }[] }).props[0].label = 'balloon';
  clip.elements![0] = { ...clip.elements![0], name: 'Red balloon', label: 'balloon' };
  return clip;
}

const shotNamed = (doc: SceneDoc, name: string): ShotData => getShots(doc).find((s) => s.name === name)!;

/** Hangs shot `name`'s camera from `parent`, where it stands in the world at the shot's first frame. */
function hangCamera(doc: SceneDoc, name: string, parent: string): string {
  const s = shotNamed(doc, name);
  const fs = new FrameState(doc, s.frame_start);
  doc.setParent(s.camera!, parent, true, { world: fs.world(s.camera!)!, parentWorld: fs.world(parent)! });
  return s.camera!;
}

/** The camera of shot `name`: its world matrix at every frame of the shot, and the frames it is keyed at. */
function cameraMotion(doc: SceneDoc, name: string): { worlds: Mat4[]; keyed: number[] } {
  const s = shotNamed(doc, name);
  const worlds: Mat4[] = [];
  for (let f = s.frame_start; f <= s.frame_end; f++) worlds.push(worldAt(doc, s.camera!, f));
  const keyed = doc
    .listFCurves(s.camera!)
    .filter((fc) => fc.path === 'location' || fc.path === 'rotation_euler')
    .flatMap((fc) => fc.keyframes.map((k) => k.frame));
  return { worlds, keyed: [...new Set(keyed)].sort((a, b) => a - b) };
}

/** Shot `name`'s camera's world matrices at `frames`. */
const cameraAt = (doc: SceneDoc, name: string, frames: readonly number[]): Mat4[] =>
  frames.map((f) => worldAt(doc, shotNamed(doc, name).camera!, f));

const largest = (a: readonly Mat4[], b: readonly Mat4[], entries = [...Array(16).keys()]) =>
  Math.max(...a.map((m, i) => Math.max(...entries.map((k) => Math.abs(m[k] - b[i][k])))));

/** The axes of a world matrix made unit length, and its origin: where a camera stands and looks. */
const view = (m: Mat4): Mat4 => {
  const out = [...m] as Mat4;
  for (let c = 0; c < 3; c++) {
    const l = Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]);
    for (let r = 0; r < 3; r++) out[c * 4 + r] = m[c * 4 + r] / l;
  }
  return out;
};

/** A document with `first` imported, then `again` (the reference: nothing hung from anything). */
function reimported(first: () => ReturnType<typeof kiteClip>, again: () => ReturnType<typeof kiteClip>) {
  const doc = SceneDoc.create({ empty: true });
  importClip(doc, first());
  return { doc, r: importClip(doc, again()) };
}

/** An empty the person made as a camera rig (named `name`, on `parent` when given). */
function rig(doc: SceneDoc, rotation: Vec3, scale: Vec3, name = 'Rig', parent: string | null = null): string {
  let id = '';
  doc.transact(() => {
    id = doc.addObject({
      type: 'EMPTY',
      name,
      location: [3, -2, 1.5],
      rotation_euler: rotation,
      scale,
      parent,
    });
  });
  return id;
}

describe('rideo re-import of a shot camera the person hung from another object', () => {
  /** Shot 1's camera hung from the kite, the clip imported again with `again`: the import's result. */
  function flownCamera(again: () => ReturnType<typeof kiteClip>, flyer: string) {
    const ref = reimported(kiteClip, again);
    const doc = SceneDoc.create({ empty: true });
    const cam = hangCamera(doc, 'Shot 1', importClip(doc, kiteClip()).props[0].id);
    const r = importClip(doc, again());
    // it flies through shot 1: the camera stands where the blocking has it, on nothing
    expect(doc.getObject(cam)!.parent).toBeNull();
    expect(largest(cameraMotion(doc, 'Shot 1').worlds, cameraMotion(ref.doc, 'Shot 1').worlds)).toBeLessThan(
      1e-9,
    );
    expect(r.warnings).toContain(
      `Shot 1: its camera hung from '${flyer}', which moves during the shot; the import took it off '${flyer}' to place it where the clip's blocking has it`,
    );
    // and the camera is named as changed since the last import, its changes gone as that says
    expect(changedWarnings(r.warnings).join('\n')).toContain("the camera of shot 'Shot 1'");
    return { doc, ref };
  }

  it('takes a camera hung from a prop built anew that flies in the shot off it, where the blocking has it', () => {
    // the kite drawn as a balloon now: built anew, the camera hung from it as from the kite
    const { doc, ref } = flownCamera(balloonClip, 'balloon');
    // the import recorded the camera it left: the next one names nothing of it
    const third = importClip(doc, balloonClip());
    expect(third.warnings.filter((w) => w.includes('Shot 1') || CHANGED.test(w))).toEqual([]);
    expect(largest(cameraMotion(doc, 'Shot 1').worlds, cameraMotion(ref.doc, 'Shot 1').worlds)).toBeLessThan(
      1e-9,
    );
  });

  it('takes a camera hung from a kept prop that flies in the shot off it, where the blocking has it', () => {
    flownCamera(kiteClip, 'kite');
  });

  it("keeps a camera hung from a rig that stands still, placed in the rig's space where the blocking has it", () => {
    const ref = reimported(dialogueClip, dialogueClip);
    const doc = SceneDoc.create({ empty: true });
    importClip(doc, dialogueClip());
    // turned on every axis and scaled evenly, as a crane or a dolly the person built
    const rigId = rig(doc, [0.3, -0.2, 0.7], [2, 2, 2]);
    const names = getShots(doc).map((s) => s.name);
    const cams = names.map((n) => hangCamera(doc, n, rigId));
    const r = importClip(doc, dialogueClip());
    for (const [i, name] of names.entries()) {
      expect(doc.getObject(cams[i])!.parent).toBe(rigId);
      const got = cameraMotion(doc, name);
      const want = cameraMotion(ref.doc, name).worlds;
      // where the blocking has it at every key (shots 4 and 5 move: a push-in and a pan), and the
      // still shots at every frame; between the keys of a move the camera's channels interpolate in
      // the rig's turned space, a few micrometres off
      const keys = got.keyed;
      expect(keys.length === 0 || name === 'Shot 4' || name === 'Shot 5').toBe(true);
      if (keys.length) {
        expect(keys).toEqual(cameraMotion(ref.doc, name).keyed);
        expect(largest(cameraAt(doc, name, keys), cameraAt(ref.doc, name, keys))).toBeLessThan(1e-9);
      }
      expect(largest(got.worlds, want)).toBeLessThan(keys.length ? 1e-4 : 1e-9);
      expect(r.warnings).toContain(
        `${name}: its camera stays hung from 'Rig', which stands still in the shot; the import placed it in its space where the clip's blocking has it`,
      );
    }
    expect(r.warnings.filter((w) => w.includes('took it off'))).toEqual([]);
    expect(r.shots.filter((s) => s.camera_from === 'blocking').length).toBe(names.length);
    // the camera recorded on the rig: the next import names nothing of it
    const third = importClip(doc, dialogueClip());
    expect(third.warnings.filter((w) => w.includes('Rig') || CHANGED.test(w))).toEqual([]);
    for (const [i, name] of names.entries()) {
      expect(doc.getObject(cams[i])!.parent).toBe(rigId);
      expect(largest(cameraMotion(doc, name).worlds, cameraMotion(ref.doc, name).worlds)).toBeLessThan(1e-4);
    }
  });

  it('keeps a camera on a rig that moves only in other shots, and takes one off it where it moves', () => {
    const ref = reimported(dialogueClip, dialogueClip);
    const doc = SceneDoc.create({ empty: true });
    importClip(doc, dialogueClip());
    const rigId = rig(doc, [0, 0, 0.7], [1, 1, 1]);
    const [one, two] = [shotNamed(doc, 'Shot 1'), shotNamed(doc, 'Shot 2')];
    // the rig still through shot 1 and travelling through shot 2
    doc.transact(() =>
      doc.setFCurve({
        target_type: 'object',
        target_id: rigId,
        path: 'location',
        index: 0,
        keyframes: [
          { frame: one.frame_end, value: 3, interpolation: 'BEZIER' },
          { frame: two.frame_end, value: 9, interpolation: 'BEZIER' },
        ],
        extrapolation: 'CONSTANT',
        mute: false,
      }),
    );
    const camOne = hangCamera(doc, 'Shot 1', rigId);
    const camTwo = hangCamera(doc, 'Shot 2', rigId);
    const r = importClip(doc, dialogueClip());
    expect(doc.getObject(camOne)!.parent).toBe(rigId);
    expect(doc.getObject(camTwo)!.parent).toBeNull();
    for (const name of ['Shot 1', 'Shot 2'])
      expect(largest(cameraMotion(doc, name).worlds, cameraMotion(ref.doc, name).worlds)).toBeLessThan(1e-9);
    expect(r.warnings).toContain(
      "Shot 2: its camera hung from 'Rig', which moves during the shot; the import took it off 'Rig' to place it where the clip's blocking has it",
    );
  });

  it('takes a camera off a rig scaled unevenly, skewed or mirrored, to stand and look where the blocking has it', () => {
    const ref = reimported(dialogueClip, dialogueClip);
    for (const how of ['uneven', 'mirrored', 'skewed'] as const) {
      const doc = SceneDoc.create({ empty: true });
      importClip(doc, dialogueClip());
      const id =
        how === 'uneven'
          ? rig(doc, [0.3, -0.2, 0.7], [1, 2, 1])
          : how === 'mirrored'
            ? rig(doc, [0.3, -0.2, 0.7], [-1, 1, 1])
            : // turned an eighth on a base stretched along Y: its axes as long as each other, not square
              rig(
                doc,
                [0, 0, Math.PI / 4],
                [1, 1, 1],
                'Rig',
                rig(doc, [0, 0, 0], [1, 2, Math.sqrt(2.5)], 'Base'),
              );
      const cam = hangCamera(doc, 'Shot 1', id);
      const r = importClip(doc, dialogueClip());
      expect(doc.getObject(cam)!.parent).toBeNull();
      // it keeps the stretch the rig gave it in the world (its scale), which no view uses
      expect(
        largest(
          cameraMotion(doc, 'Shot 1').worlds.map(view),
          cameraMotion(ref.doc, 'Shot 1').worlds.map(view),
        ),
      ).toBeLessThan(1e-9);
      expect(r.warnings).toContain(
        "Shot 1: its camera hung from 'Rig', which is scaled unevenly or mirrored; the import took it off 'Rig' to place it where the clip's blocking has it",
      );
    }
  });
});
