import { describe, expect, it } from 'vitest';
import type { DeskFraming } from '../src/doc/types';
import type { SceneDoc } from '../src/doc/scene-doc';
import { createCube } from '../src/mesh/primitives';
import { createActor } from '../src/desk/characters';
import { DeskScene, isWaterLabel, projectPoint, viewFromPose } from '../src/desk/layout';
import {
  FRAMING_TABLE,
  cameraMoveOf,
  defaultAngle,
  shotSpec,
  solveCamera,
  type LinePoints,
  type SolveSpec,
} from '../src/desk/solver';
import { lineOfAction, linePointsAt, mainPair, mainPairOf } from '../src/desk/line';
import { setShots } from '../src/desk/shots';
import { deskDoc, ed, expectNear, landmark, prop, rideo, rideoCamera, standIn } from './desk-fixtures';

/*
 * The camera solver against rideo's own solveCamera (packages/shared/src/blocking): the values below
 * were computed by running rideo's functions on the same blockings and are frozen here in rideo's
 * coordinates (x right, y up, z toward the audience), rounded to the millimetre as rideo places
 * cameras. The scenes are laid out with rideo's numbers (desk-fixtures.ts).
 */

interface Golden {
  pos: number[];
  target: number[];
  lens: number;
  end: { pos: number[]; target: number[] } | null;
}

const spec = (framing: DeskFraming, subjects: string[], o: Partial<SolveSpec> = {}): SolveSpec => ({
  framing,
  angle: 'front',
  height: 'eye',
  move: null,
  lens_mm: FRAMING_TABLE[framing].lens_mm,
  subjects,
  ...o,
});

function expectSolved(
  scene: DeskScene,
  s: SolveSpec,
  g: Golden,
  what: string,
  o: { line?: LinePoints | null; fallbackTarget?: [number, number, number] } = {},
): void {
  const c = solveCamera(scene, s, 1, o);
  expectNear(rideo(c.position), g.pos, 1.5e-3, `${what} position`);
  expectNear(rideo(c.target), g.target, 1.5e-3, `${what} target`);
  expect(c.lens_mm, `${what} lens`).toBe(g.lens);
  if (!g.end) expect(c.end, `${what} end`).toBeNull();
  else {
    expectNear(rideo(c.end!.position), g.end.pos, 1.5e-3, `${what} end position`);
    expectNear(rideo(c.end!.target), g.end.target, 1.5e-3, `${what} end target`);
  }
}

const cam = (pos: number[], target: number[], lens: number, end: Golden['end'] = null): Golden => ({
  pos,
  target,
  lens,
  end,
});

/** One stand-in at the origin facing the audience. */
function single(aspect = 16 / 9, height = 1.7): { doc: SceneDoc; scene: DeskScene; a: string } {
  const doc = deskDoc(aspect);
  const a = standIn(doc, 'Ada', 0, 0, 0, height);
  return { doc, scene: new DeskScene(doc), a };
}

/** Ada at x −0.8 and Ben (1.8 m) at x 0.8 facing each other. */
function two(aspect = 16 / 9) {
  const doc = deskDoc(aspect);
  const a = standIn(doc, 'Ada', -0.8, 0, 90);
  const b = standIn(doc, 'Ben', 0.8, 0, 270, 1.8);
  return { doc, scene: new DeskScene(doc), a, b };
}

describe('solveCamera (rideo goldens)', () => {
  it('frames a single subject at every framing (16:9 and 9:16)', () => {
    const golden: Record<DeskFraming, Golden> = {
      extreme_wide: cam([0, 1.581, 8.859], [0, 0.85, 0], 18),
      wide: cam([0, 1.581, 4.924], [0, 0.85, 0], 24),
      medium: cam([0, 1.581, 2.131], [0, 1.224, 0], 35),
      medium_close: cam([0, 1.581, 2.087], [0, 1.36, 0], 50),
      close_up: cam([0, 1.581, 1.889], [0, 1.564, 0], 85),
      extreme_close_up: cam([0, 1.581, 1.086], [0, 1.581, 0], 100),
      over_shoulder: cam([0, 1.581, 2.715], [0, 1.496, 0], 50),
      pov: cam([0, 1.581, 3.456], [0, 1.53, 0], 28),
      insert: cam([0, 1.581, 1.319], [0, 0.935, 0], 85),
    };
    const { scene, a } = single();
    for (const [framing, g] of Object.entries(golden) as [DeskFraming, Golden][])
      expectSolved(scene, spec(framing, [a]), g, framing);
    const tall = single(9 / 16);
    expectSolved(tall.scene, spec('wide', [tall.a]), cam([0, 1.581, 1.395], [0, 0.85, 0], 24), '9:16 wide');
    expectSolved(
      tall.scene,
      spec('medium', [tall.a]),
      cam([0, 1.581, 0.583], [0, 1.224, 0], 35),
      '9:16 medium',
    );
    expectSolved(
      tall.scene,
      spec('close_up', [tall.a]),
      cam([0, 1.581, 0.597], [0, 1.564, 0], 85),
      '9:16 close up',
    );
  });

  it('places the camera at every height and angle, with a given lens', () => {
    const { scene, a } = single();
    const heights = {
      medium: {
        eye: cam([0, 1.581, 2.131], [0, 1.224, 0], 35),
        low: cam([0, 0.4, 1.997], [0, 1.224, 0], 35),
        high: cam([0, 2.9, 1.363], [0, 1.224, 0], 35),
        overhead: cam([0, 5.7, 0.648], [0, 1.224, 0], 35),
      },
      wide: {
        eye: cam([0, 1.581, 4.924], [0, 0.85, 0], 24),
        low: cam([0, 0.4, 4.957], [0, 0.85, 0], 24),
        high: cam([0, 2.9, 4.536], [0, 0.85, 0], 24),
        overhead: cam([0, 5.7, 1.493], [0, 0.85, 0], 24),
      },
    } as const;
    for (const [framing, byHeight] of Object.entries(heights))
      for (const [height, g] of Object.entries(byHeight))
        expectSolved(
          scene,
          spec(framing as DeskFraming, [a], { height: height as SolveSpec['height'] }),
          g,
          `${framing} ${height}`,
        );
    const angles = {
      front: cam([0, 1.581, 2.131], [0, 1.224, 0], 35),
      three_quarter_left: cam([1.222, 1.581, 1.745], [0, 1.224, 0], 35),
      three_quarter_right: cam([-1.222, 1.581, 1.745], [0, 1.224, 0], 35),
      profile_left: cam([2.131, 1.581, 0], [0, 1.224, 0], 35),
      profile_right: cam([-2.131, 1.581, 0], [0, 1.224, 0], 35),
      back: cam([0, 1.581, -2.131], [0, 1.224, 0], 35),
    } as const;
    for (const [angle, g] of Object.entries(angles))
      expectSolved(scene, spec('medium', [a], { angle: angle as SolveSpec['angle'] }), g, angle);
    // rideo rounds the lens to the millimetre
    expectSolved(
      scene,
      spec('medium', [a], { lens_mm: 60.4 }),
      cam([0, 1.581, 3.686], [0, 1.224, 0], 60),
      'lens',
    );
  });

  it("gives the end of each move the solver plans, and names the move from it (rideo's cameraMoveOf)", () => {
    const { scene, a } = single();
    const start = { pos: [0, 1.581, 2.131], target: [0, 1.224, 0] };
    const ends = {
      push_in: { pos: [0, 1.456, 1.385], target: [0, 1.224, 0] },
      pull_out: { pos: [0, 1.706, 2.877], target: [0, 1.224, 0] },
      dolly_left: { pos: [-1.5, 1.581, 2.131], target: [-1.5, 1.224, 0] },
      dolly_right: { pos: [1.5, 1.581, 2.131], target: [1.5, 1.224, 0] },
      orbit_left: { pos: [-1.065, 1.581, 1.846], target: [0, 1.224, 0] },
      orbit_right: { pos: [1.065, 1.581, 1.846], target: [0, 1.224, 0] },
      crane_up: { pos: [0, 3.581, 2.131], target: [0, 1.224, 0] },
    } as const;
    for (const [move, end] of Object.entries(ends)) {
      const s = spec('medium', [a], { move: move as SolveSpec['move'] });
      expectSolved(
        scene,
        s,
        { ...start, lens: 35, end: { pos: [...end.pos], target: [...end.target] } },
        move,
      );
      const c = solveCamera(scene, s, 1);
      expect(cameraMoveOf(c, c.end), move).toBe(move);
    }
    const still = solveCamera(scene, spec('medium', [a]), 1);
    // no end, or an end too close to call: no move
    expect(cameraMoveOf(still, null)).toBeNull();
    const nudged = {
      position: [still.position[0] + 0.05, still.position[1], still.position[2]],
      target: still.target,
    };
    expect(cameraMoveOf(still, nudged as typeof still)).toBeNull();
  });

  it('follows a turned, taller subject off the origin, a sitting one and a small one', () => {
    const doc = deskDoc();
    const a = standIn(doc, 'Ada', 1.5, -2, 130, 1.9);
    const scene = new DeskScene(doc);
    const turned = {
      front: cam([3.287, 1.767, -3.499], [1.5, 1.52, -2], 50),
      three_quarter_left: cam([2.104, 1.767, -4.253], [1.5, 1.52, -2], 50),
      profile_right: cam([2.999, 1.767, -0.213], [1.5, 1.52, -2], 50),
      back: cam([-0.287, 1.767, -0.501], [1.5, 1.52, -2], 50),
    } as const;
    for (const [angle, g] of Object.entries(turned))
      expectSolved(
        scene,
        spec('medium_close', [a], { angle: angle as SolveSpec['angle'] }),
        g,
        `turned ${angle}`,
      );
    // sitting: the posed height is 0.72 of 1.7 m (CHARACTERS reports the posed head)
    const sitting = single(16 / 9, 0.72 * 1.7);
    expectSolved(
      sitting.scene,
      spec('medium', [sitting.a]),
      cam([0, 1.138, 1.534], [0, 0.881, 0], 35),
      'sitting',
    );
    const small = single(16 / 9, 0.4);
    expectSolved(
      small.scene,
      spec('medium', [small.a], { height: 'low' }),
      cam([0, 0.24, 0.646], [0, 0.288, 0], 35),
      'small medium',
    );
    expectSolved(
      small.scene,
      spec('wide', [small.a], { height: 'low' }),
      cam([0, 0.24, 1.493], [0, 0.2, 0], 24),
      'small wide',
    );
  });

  it('frames two subjects: fronts, three-quarters, back, over the shoulder both ways and points of view', () => {
    const { scene, a, b } = two();
    expectSolved(scene, spec('wide', [a, b]), cam([0, 1.674, 5.213], [0, 0.9, 0], 24), 'wide');
    expectSolved(scene, spec('medium', [a, b]), cam([0, 1.674, 2.256], [0, 1.296, 0], 35), 'medium');
    expectSolved(
      scene,
      spec('medium', [a, b], { angle: 'three_quarter_left' }),
      cam([1.375, 1.674, 1.964], [0, 1.296, 0], 35),
      'medium three-quarter',
    );
    expectSolved(
      scene,
      spec('medium', [a, b], { angle: 'back' }),
      cam([0, 1.674, -2.256], [0, 1.296, 0], 35),
      'medium back',
    );
    expectSolved(
      scene,
      spec('over_shoulder', [a, b], { angle: 'over_shoulder' }),
      cam([-1.382, 1.462, 0.339], [0.8, 1.674, 0], 50),
      'over Ada',
    );
    expectSolved(
      scene,
      spec('over_shoulder', [b, a], { angle: 'over_shoulder' }),
      cam([1.382, 1.548, -0.339], [-0.8, 1.581, 0], 50),
      'over Ben',
    );
    expectSolved(
      scene,
      spec('pov', [a, b], { angle: 'pov' }),
      cam([-0.68, 1.581, 0], [0.8, 1.674, 0], 28),
      "Ada's view of Ben",
    );
    expectSolved(
      scene,
      spec('pov', [a], { angle: 'pov' }),
      cam([-0.68, 1.581, 0], [3.32, 1.581, 0], 28),
      "Ada's view",
    );
    const tall = two(9 / 16);
    expectSolved(
      tall.scene,
      spec('medium', [tall.a, tall.b]),
      cam([0, 1.674, 2.246], [0, 1.296, 0], 35),
      '9:16',
    );
  });

  it('frames a group of three', () => {
    const doc = deskDoc();
    const ids = [
      standIn(doc, 'Ada', -1.2, 0.3, 20),
      standIn(doc, 'Ben', 0, -0.4, 0, 1.8),
      standIn(doc, 'Cy', 1.1, 0.5, -30, 1.2),
    ];
    const scene = new DeskScene(doc);
    expectSolved(scene, spec('wide', ids), cam([2.594, 1.674, 4.637], [-0.033, 0.9, 0.133], 24), 'wide');
    expectSolved(
      scene,
      spec('medium', ids),
      cam([1.544, 1.674, 2.837], [-0.033, 1.296, 0.133], 35),
      'medium',
    );
    expectSolved(
      scene,
      spec('medium', ids, { angle: 'three_quarter_left' }),
      cam([2.016, 1.674, 1.078], [-0.033, 1.296, 0.133], 35),
      'three-quarter',
    );
    expectSolved(
      scene,
      spec('close_up', ids, { height: 'high' }),
      cam([3.224, 3, 5.717], [-0.033, 1.656, 0.133], 85),
      'close-up from high',
    );
  });

  it('frames the prop of an insert, and the fallback target of a shot without subjects', () => {
    const doc = deskDoc();
    const a = standIn(doc, 'Ada', 0.5, 0.2, 45);
    const kite = prop(doc, 'kite', -0.3, 0.6, 0.3);
    const scene = new DeskScene(doc);
    expectSolved(
      scene,
      spec('insert', [a, kite]),
      cam([0.012, 1.581, 0.912], [-0.3, 0.15, 0.6], 85),
      'insert',
    );
    expectSolved(scene, spec('wide', []), cam([0, 1.5, 1.407], [0, 1, 0], 24), 'no subjects', {
      fallbackTarget: [0, 0, 1],
    });
  });

  it('pushes the camera out of solid landmarks, not out of water', () => {
    const boxed = single();
    landmark(boxed.doc, 'hut', 0, 2.5, 2, 1.5, 2.5);
    expectSolved(
      new DeskScene(boxed.doc),
      spec('medium', [boxed.a]),
      cam([0, 1.829, 3.61], [0, 1.224, 0], 35),
      'pushed out of the hut',
    );
    // a 4 × 3 × 3 m box where the medium camera (rideo z 2.131, 1.581 m up) stands: water lets it
    // in, any other landmark pushes it out to where rideo pushes it out of a box
    const inside = cam([0, 1.581, 2.131], [0, 1.224, 0], 35);
    const pushed = cam([0, 1.911, 4.103], [0, 1.224, 0], 35);
    const solve = (label: string, props: Record<string, string> = {}) => {
      const t = single();
      const box = landmark(t.doc, label, 0, 2.5, 4, 3, 3);
      t.doc.updateObject(box, { custom_props: { ...t.doc.getObject(box)!.custom_props, ...props } });
      return { scene: new DeskScene(t.doc), a: t.a };
    };
    for (const label of ['lake', 'the ocean', 'a swimming pool', 'the pond by the barn', 'the bay']) {
      const t = solve(label);
      expectSolved(t.scene, spec('medium', [t.a]), inside, `in ${label}`);
    }
    for (const label of ['the lakeside cabin', 'the research hut', 'a pool table', 'the seats', 'sea wall']) {
      const t = solve(label);
      expectSolved(t.scene, spec('medium', [t.a]), pushed, `out of ${label}`);
    }
    // an explicit shape (rideo's landmark shape, set by the import) wins over the label
    const marked = solve('the bath', { desk_shape: 'water' });
    expectSolved(marked.scene, spec('medium', [marked.a]), inside, 'shape water');
    const boxShape = solve('the lake', { desk_shape: 'box' });
    expectSolved(boxShape.scene, spec('medium', [boxShape.a]), pushed, 'shape box');
    // a model's water part (store_part 'water', CATALOG's convention) lets cameras in, its other
    // parts do not
    const fountain = (part: string) => {
      const t = single();
      const root = t.doc.addObject({
        type: 'EMPTY',
        name: 'Fountain',
        location: ed(0, 0, 2.5),
        custom_props: { desk_role: 'landmark', desk_label: 'the fountain' },
      });
      t.doc.addObject({
        type: 'MESH',
        name: part,
        data: t.doc.addMesh(part, createCube({ size: 1 })),
        parent: root,
        location: [0, 0, 1.5],
        scale: [4, 3, 3],
        custom_props: { store_part: part },
      });
      return { scene: new DeskScene(t.doc), a: t.a };
    };
    const water = fountain('water');
    expectSolved(water.scene, spec('medium', [water.a]), inside, "the fountain's water");
    const basin = fountain('basin');
    expectSolved(basin.scene, spec('medium', [basin.a]), pushed, "the fountain's basin");
    expect(
      ['the lake', 'Lake', 'a swimming pool', 'the river', 'the pond by the barn', 'open water'].map(
        isWaterLabel,
      ),
    ).toEqual([true, true, true, true, true, true]);
    expect(
      ['the lakeside cabin', 'the research hut', 'a pool table', 'the seats', 'lake house', ''].map(
        isWaterLabel,
      ),
    ).toEqual([false, false, false, false, false, false]);
  });

  it('pushes a low camera out of a landmark sideways, not down through the floor (rideo)', () => {
    // rideo: Ada (1.18 m) at (−2.44, 2.46) facing 184°, a 3 × 3 × 3 barn at (−2.7, 1.2); a low
    // three-quarter close-up looks up at her from inside the barn and backs out of it
    const doc = deskDoc(7 / 3);
    const a = standIn(doc, 'Ada', -2.44, 2.46, 184, 1.18);
    landmark(doc, 'barn', -2.7, 1.2, 3, 3, 3);
    const scene = new DeskScene(doc);
    const s = spec('close_up', [a], { angle: 'three_quarter_left', height: 'low', lens_mm: 96 });
    expectSolved(scene, s, cam([-4.411, 0.05, 0.026], [-2.44, 1.086, 2.46], 96), 'low close-up');
    expect(scene.insideSolid(solveCamera(scene, s, 1).position, 1)).toBeNull();
  });
});

describe('actors CHARACTERS measures (their posed bodies)', () => {
  /** An adult built by CHARACTERS at the origin facing the audience, in `pose`. */
  function actor(pose: string, kind: 'adult' | 'horse' = 'adult') {
    const doc = deskDoc();
    const { actor: id } = createActor(doc, { kind, location: [0, 0, 0], facing_deg: 0, pose });
    return { doc, id, scene: new DeskScene(doc) };
  }

  it('stand on their mark (the armature origin), not on the middle of their soles', () => {
    for (const pose of ['stand', 'sit', 'sit_ground', 'lie']) {
      const { id, scene } = actor(pose);
      const s = scene.subject(id, 1)!;
      expect(s.posed, pose).toBe(true);
      expectNear([s.feet[0], s.feet[1]], [0, 0], 1e-9, `${pose} mark`);
      expect(s.height, pose).toBeCloseTo(s.head[2] - s.feet[2], 9);
    }
    // a lying horse rests on its body, its hooves up: it is as tall as its head is high
    const horse = actor('lie', 'horse');
    const h = horse.scene.subject(horse.id, 1)!;
    expect(h.feet[2]).toBeLessThan(0.1);
    expect(h.height).toBeGreaterThan(h.head[2] - 0.1);
  });

  it('are framed on their face in a close-up, whatever the pose and the angle', () => {
    for (const pose of ['stand', 'sit', 'sit_ground', 'lie']) {
      const { id, scene } = actor(pose);
      for (const angle of ['front', 'three_quarter_right', 'profile_left'] as const) {
        const c = solveCamera(scene, spec('close_up', [id], { angle }), 1);
        const view = viewFromPose(c.position, c.target, c.lens_mm, scene.aspect);
        const eyes = projectPoint(view, scene.subject(id, 1)!.eyes);
        const what = `${pose} ${angle}`;
        expect(eyes.depth, what).toBeGreaterThan(0.2);
        expect(Math.abs(eyes.x), what).toBeLessThan(0.2);
        expect(Math.abs(eyes.y), what).toBeLessThan(0.3);
      }
    }
  });

  it('frame a standing person where rideo frames its figure', () => {
    const { id, scene } = actor('stand');
    const s = scene.subject(id, 1)!;
    for (const framing of ['wide', 'medium', 'medium_close', 'close_up'] as const) {
      const c = solveCamera(scene, spec(framing, [id]), 1);
      // rideo's figure of the same height over the same mark
      const rideoTarget = s.feet[2] + Math.max(0.3, s.height) * FRAMING_TABLE[framing].look;
      expect(Math.abs(c.target[2] - rideoTarget), framing).toBeLessThan(0.02);
      expect(Math.hypot(c.target[0], c.target[1]), framing).toBeLessThan(0.1);
    }
  });
});

describe('the line of action in the solver', () => {
  /** rideo's shots: the pair wide, Ada close, the pair medium, Ben close; the first one placed. */
  function placed() {
    const t = two();
    const cam1 = rideoCamera(t.doc, 'Cam 1', [0, 1.674, 5.213], [0, 0.9, 0], 24);
    setShots(t.doc, [
      {
        id: 's1',
        name: 'S1',
        camera: cam1,
        frame_start: 1,
        frame_end: 24,
        framing: 'wide',
        subjects: [t.a, t.b],
      },
      { id: 's2', name: 'S2', frame_start: 25, frame_end: 48, framing: 'close_up', subjects: [t.a] },
      { id: 's3', name: 'S3', frame_start: 49, frame_end: 72, framing: 'medium', subjects: [t.a, t.b] },
      { id: 's4', name: 'S4', frame_start: 73, frame_end: 96, framing: 'close_up', subjects: [t.b] },
    ]);
    return { ...t, scene: new DeskScene(t.doc) };
  }

  it('takes the pair sharing the most shots and the side of the first camera framing both', () => {
    const { doc, scene, a, b } = placed();
    expect(mainPair(doc, scene)).toEqual([a, b]);
    expect(lineOfAction(scene)).toEqual({ a, b, side: 1 });
    // singles only: the two seen most
    expect(mainPairOf([{ subjects: ['x'] }, { subjects: ['y'] }, { subjects: ['y'] }], () => true)).toEqual([
      'y',
      'x',
    ]);
    expect(mainPairOf([{ subjects: ['x'] }], () => true)).toBeNull();
  });

  it("keeps later cameras on the scene's side, as rideo's solver does", () => {
    const { scene, a, b } = placed();
    const line = linePointsAt(scene, lineOfAction(scene), 25);
    expect(line).not.toBeNull();
    // the default angle of shot 2 (one actor, index 1) is three-quarter right
    expect(defaultAngle('close_up', 1, 1)).toBe('three_quarter_right');
    expect(
      shotSpec(
        scene,
        { framing: 'close_up', angle: null, height: null, move: null, lens_mm: null, subjects: [a] },
        1,
      ),
    ).toMatchObject({ angle: 'three_quarter_right', height: 'eye', lens_mm: 85 });
    const opts = { line };
    expectSolved(
      scene,
      spec('close_up', [a], { angle: 'three_quarter_right' }),
      cam([0.747, 1.581, 1.083], [-0.8, 1.564, 0], 85),
      'shot 2',
      opts,
    );
    expectSolved(
      scene,
      spec('close_up', [a], { angle: 'back' }),
      cam([-2.577, 1.581, 0.64], [-0.8, 1.564, 0], 85),
      'shot 2 from the back',
      opts,
    );
    expectSolved(
      scene,
      spec('medium', [a, b], { angle: 'back' }),
      cam([0, 1.674, -2.256], [0, 1.296, 0], 35),
      'shot 3 from the back',
      opts,
    );
    expectSolved(
      scene,
      spec('close_up', [b], { angle: 'profile_left' }),
      cam([0.8, 1.674, 2], [0.8, 1.656, 0], 85),
      'shot 4 in profile',
      opts,
    );
  });
});
