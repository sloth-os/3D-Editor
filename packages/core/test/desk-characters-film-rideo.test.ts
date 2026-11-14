import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import type { ObjectData, PoseBone } from '../src/doc/types';
import { FrameState } from '../src/eval/frame-state';
import type { Vec3 } from '../src/math/types';
import { exportRideoBlocking } from '../src/desk/rideo';
import { getShots } from '../src/desk/shots';
import type { ActorKind } from '../src/desk/characters';
import { blueprintFor, posedBones } from '../src/desk/characters/kinds';
import { requireActor } from '../src/desk/characters/rig';
import { DIALOGUE_SHOTS, MAYA, dialogueClip, importClip } from './desk-rideo-fixtures';

/*
 * The actors' poses through a rideo round trip. rideo draws each of its ten mark poses as a whole
 * figure: a 'point', 'reach' or 'wave' mark is a standing figure, whatever the mark before it. The
 * import keys each mark with applyPose (no layer), and the export reads back the pose nearest the
 * actor's bones, so a gesture mark after a seated or kneeling one must come back as that gesture.
 */

const LOWER_BONES = ['hips'].concat(
  ...['L', 'R'].map((s) => [`thigh.${s}`, `shin.${s}`, `foot.${s}`, `toe.${s}`]),
);

/** Largest rotation difference (radians) between two poses over `bones`, plus the hips' location gap. */
function poseGap(a: Record<string, PoseBone>, b: Record<string, PoseBone>, bones: string[]): number {
  let gap = 0;
  for (const bone of bones) {
    const ra = (a[bone]?.rotation_euler ?? [0, 0, 0]) as Vec3;
    const rb = (b[bone]?.rotation_euler ?? [0, 0, 0]) as Vec3;
    const la = (a[bone]?.location ?? [0, 0, 0]) as Vec3;
    const lb = (b[bone]?.location ?? [0, 0, 0]) as Vec3;
    for (let i = 0; i < 3; i++)
      gap = Math.max(
        gap,
        Math.abs(Math.atan2(Math.sin(ra[i] - rb[i]), Math.cos(ra[i] - rb[i]))),
        Math.abs(la[i] - lb[i]),
      );
  }
  return gap;
}

describe('desk actors through a rideo round trip', () => {
  it('a gesture mark after a seated or kneeling mark imports standing and exports as the gesture', () => {
    const LAST = DIALOGUE_SHOTS[5];
    const cases: { stance: string; gesture: string; at: [number, number] }[] = [
      { stance: 'sit', gesture: 'point', at: [-0.9, 0] },
      { stance: 'sit', gesture: 'reach', at: [-0.9, 0] },
      { stance: 'kneel', gesture: 'wave', at: [-0.9, 0] },
      // the mark moves her elsewhere: she must not sit in the air there
      { stance: 'sit', gesture: 'point', at: [1.4, 0.6] },
    ];
    for (const { stance, gesture, at } of cases) {
      const what = `${stance} then ${gesture} at ${at}`;
      const input = dialogueClip();
      const blocking = input.blocking as {
        actors: { characterId: string; pose: string }[];
        shots: Record<string, { marks?: Record<string, unknown> }>;
      };
      const maya = blocking.actors.find((a) => a.characterId === MAYA)!;
      maya.pose = stance;
      blocking.shots[LAST].marks = { [MAYA]: { x: at[0], z: at[1], facingDeg: 90, pose: gesture } };
      const doc = SceneDoc.create({ empty: true });
      importClip(doc, input);
      const id = [...doc.listObjects()].find((o) => o.custom_props?.desk_character_id === MAYA)!.id;
      const shot = getShots(doc).find((s) => s.external?.shot === LAST)!;
      const meta = requireActor(doc, id);
      const kind = meta.kind as ActorKind;
      const figure = posedBones(
        kind,
        doc.getArmature(meta.armature)!,
        blueprintFor(kind, meta.height),
        gesture,
      );
      for (const f of [shot.frame_start, shot.frame_end]) {
        const bones = (new FrameState(doc, f).get<ObjectData>('object', id)?.pose?.bones ?? {}) as Record<
          string,
          PoseBone
        >;
        // the whole figure: its legs stand as the gesture's do
        expect(poseGap(bones, figure, LOWER_BONES), `${what}, frame ${f}`).toBeLessThan(1e-6);
      }
      const back = exportRideoBlocking(doc).blocking;
      expect(back.actors.find((a) => a.characterId === MAYA)?.pose, what).toBe(stance);
      expect(back.shots[LAST]?.marks?.[MAYA]?.pose, what).toBe(gesture);
    }
  });
});
