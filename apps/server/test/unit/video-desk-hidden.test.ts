import { describe, expect, it } from 'vitest';
import {
  HIDDEN_SCALE_EPS,
  SceneDoc,
  SceneEvaluator,
  collapsedBox,
  createCube,
  createEditorState,
  createFCurve,
  createMesh,
  createOperatorRegistry,
  defaultAoRadius,
  evaluatedBounds,
  hiddenByScale,
  hiddenScale,
  insertKeyframe,
  renderItems,
  type FCurve,
  type Mat4,
  type OperatorContext,
  type Vec3,
} from '@3d-editor/core';
import { deskShotInfo, hiddenItem, renderDeskFrame } from '../../src/render/desk';
import type { DeskFrameOptions, FrameMeta } from '../../src/render/protocol';
import { ShotTracks } from '../../src/video/manifest';

/*
 * Objects hidden by their scale in video export frames (render/desk.ts): desk.tether_fly's
 * after: 'hide' and the rideo import shrink what should not be seen to a point (scale keys of
 * HIDE_SCALE times the scale it is shown at; earlier versions keyed an absolute 1e-8). Such an object
 * draws nothing in any pass (no skeleton for a shrunk actor, no string line, nothing in the mask or
 * edges), its subject box says hidden instead of a 1 px box at the point it shrank to, and it counts
 * in none of a shot's measurements. Its geometry tells it (hiddenItem), so a store model shown at a
 * tiny world scale (a model in micrometres shown 1 m tall is at 1e-6) is drawn and measured as any
 * other.
 */

const W = 160;
const H = 90;

/** A scene with the operator registry (desk operators run as agents run them). */
function deskScene() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: () => {},
  };
  const run = <T = Record<string, unknown>>(id: string, params: Record<string, unknown>): T => {
    const r = reg.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id}: ${r.error}`);
    return r.result as T;
  };
  return { doc, run };
}

/** Keys `id` hidden (scale 1e-8, as the rideo import's hide keys) from frame `from` on. */
function hideFrom(doc: SceneDoc, id: string, from: number): void {
  const shown = doc.getObject(id)!.scale;
  for (let i = 0; i < 3; i++) {
    let fc: FCurve = createFCurve({ target_type: 'object', target_id: id, path: 'scale', index: i });
    fc = insertKeyframe(fc, from - 1, shown[i], 'CONSTANT');
    fc = insertKeyframe(fc, from, 1e-8, 'CONSTANT');
    doc.setFCurve(fc);
  }
}

/**
 * Ada flies a kite from her right hand over frames 1–12 (after: 'hide': the kite, its tail and its
 * string are hidden from frame 13); Ben, beside her, is hidden from frame 13 by his own scale keys.
 */
function kiteDay() {
  const { doc, run } = deskScene();
  doc.updateScene({ fps: 24, frame_start: 1, frame_end: 40 });
  const cam = doc.addObject({
    type: 'CAMERA',
    name: 'Cam',
    data: doc.addCamera({ lens: 24 }),
    location: [2, -14, 4],
    rotation_euler: [Math.PI / 2 - 0.12, 0, 0],
  });
  doc.updateScene({ camera: cam });
  const ada = run<{ actor: string }>('desk.actor_add', {
    kind: 'woman',
    name: 'Ada',
    location: [-1, 0, 0],
  }).actor;
  const ben = run<{ actor: string }>('desk.actor_add', {
    kind: 'man',
    name: 'Ben',
    location: [1.2, 0, 0],
  }).actor;
  const kite = run<{ root: string }>('store.add', { model: 'diamond_kite', name: 'Kite' }).root;
  const fly = run<{ string: { object: string } | null; hidden_from: number | null }>('desk.tether_fly', {
    flyer: kite,
    anchor: ada,
    anchor_bone: 'hand.R',
    length_m: 8,
    wind_dir_deg: 90,
    wind_mps: 6,
    frame_start: 1,
    frame_end: 12,
    after: 'hide',
  });
  expect(fly.hidden_from).toBe(13);
  const string = fly.string!.object;
  hideFrom(doc, ben, 13);
  return { doc, cam, ada, ben, kite, string, evaluator: new SceneEvaluator(doc) };
}

type KiteDay = ReturnType<typeof kiteDay>;

function frameOptions(s: KiteDay): DeskFrameOptions {
  return {
    look: 'material',
    shadows: false,
    ao: false,
    msaa: true,
    passes: ['beauty', 'mask', 'edges', 'pose'],
    // mask indices: Ada 1, Ben 2, the kite 3, its string 4
    objectPalette: {
      [s.ada]: [255, 0, 0],
      [s.ben]: [0, 255, 0],
      [s.kite]: [0, 0, 255],
      [s.string]: [9, 9, 9],
    },
    subjects: [s.ada, s.ben, s.kite],
    poseActors: [s.ada, s.ben],
    lines: [{ object: s.string, width_px: 2, color: [1, 1, 1] }],
  };
}

const renderAt = (s: KiteDay, frame: number, desk = frameOptions(s)) =>
  renderDeskFrame(
    { doc: s.doc, evaluator: s.evaluator, simulated: () => null },
    { width: W, height: H, frame, cameraId: s.cam, samples: 1 },
    desk,
  );

/** Pixels (x, y) of a pass where `drawn(index)` holds (`channels` bytes per pixel). */
function pixels(pass: Uint8Array, channels: number, drawn: (i: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < W * H; i++) if (drawn(i * channels)) out.push([i % W, Math.floor(i / W)]);
  return out;
}

type Box = { x: number; y: number; w: number; h: number };
const inside = ([x, y]: [number, number], b: Box, margin = 3) =>
  x >= b.x - margin && x < b.x + b.w + margin && y >= b.y - margin && y < b.y + b.h + margin;

describe('objects hidden by their scale in export frames', () => {
  it('draw no skeleton, string, mask or edges, and their subject boxes say hidden', () => {
    const s = kiteDay();
    const shown = renderAt(s, 6);
    const hidden = renderAt(s, 18);
    for (const img of [shown, hidden]) expect(img.warnings).toBeUndefined();
    // the hide keys: Ben, the kite and its string are shrunk at frame 18, Ada is not
    const at18 = s.evaluator.evaluate(18, { forRender: true });
    expect(
      [s.ada, s.ben, s.kite, s.string].map((id) => hiddenByScale(at18.byId.get(id)!.worldMatrix)),
    ).toEqual([false, true, true, true]);

    // frame 6: everyone is seen, in every pass
    const boxes6 = shown.meta!.subjects;
    for (const id of [s.ada, s.ben, s.kite]) expect(boxes6[id]).toMatchObject({ visible: true });
    for (const id of [s.ada, s.ben, s.kite]) expect(boxes6[id]!.hidden).toBeUndefined();
    const mask6 = shown.passes!.mask!;
    for (const k of [1, 2, 3, 4])
      expect(pixels(mask6, 1, (i) => mask6[i] === k).length, `mask ${k}`).toBeGreaterThan(3);
    const pose6 = shown.passes!.pose!;
    const skeleton6 = pixels(pose6, 3, (i) => pose6[i] + pose6[i + 1] + pose6[i + 2] > 0);
    expect(skeleton6.filter((p) => inside(p, boxes6[s.ben]!)).length).toBeGreaterThan(10);

    // frame 18: Ada alone; the others are hidden, never a 1 px box where they shrank to
    const boxes18 = hidden.meta!.subjects;
    expect(boxes18[s.ada]).toMatchObject({ visible: true });
    for (const id of [s.ben, s.kite])
      expect(boxes18[id]).toEqual({ x: 0, y: 0, w: 0, h: 0, visible: false, hidden: true });
    const ada = boxes18[s.ada]!;
    // nothing of Ben, the kite or the string in the mask
    const mask18 = hidden.passes!.mask!;
    expect(pixels(mask18, 1, (i) => mask18[i] > 1)).toEqual([]);
    expect(pixels(mask18, 1, (i) => mask18[i] === 1).length).toBeGreaterThan(3);
    // edges and the skeletons: only Ada's (no blot of joint colours where Ben shrank to his feet)
    const edges18 = hidden.passes!.edges!;
    expect(pixels(edges18, 1, (i) => edges18[i] < 255).filter((p) => !inside(p, ada))).toEqual([]);
    const pose18 = hidden.passes!.pose!;
    const skeleton18 = pixels(pose18, 3, (i) => pose18[i] + pose18[i + 1] + pose18[i + 2] > 0);
    expect(skeleton18.length).toBeGreaterThan(10);
    expect(skeleton18.filter((p) => !inside(p, ada))).toEqual([]);
    // the beauty image has no string either: it is the beauty image of the scene without what hid
    const beauty18 = hidden.data!;
    const gone = new Set([s.ben, s.kite, s.string]);
    // with their parts (the kite's sail, spars and tail; Ben's limbs)
    for (let more = true; more;) {
      more = false;
      for (const o of s.doc.listObjects()) {
        const actor = o.custom_props?.desk_actor;
        if (
          gone.has(o.id) ||
          !((o.parent && gone.has(o.parent)) || (typeof actor === 'string' && gone.has(actor)))
        )
          continue;
        gone.add(o.id);
        more = true;
      }
    }
    for (const id of gone) s.doc.removeObject(id);
    const alone = renderAt({ ...s, evaluator: new SceneEvaluator(s.doc) }, 18, {
      ...frameOptions(s),
      lines: [],
    });
    expect(Buffer.from(beauty18).equals(Buffer.from(alone.data!))).toBe(true);
  });

  it('draw no dot for a long string shrunk to a point (its line is at least 2 px wide)', () => {
    const { doc, run } = deskScene();
    const cam = doc.addObject({
      type: 'CAMERA',
      name: 'Cam',
      data: doc.addCamera({ lens: 35 }),
      location: [0, -6, 1],
      rotation_euler: [Math.PI / 2, 0, 0],
    });
    doc.updateScene({ camera: cam });
    run('desk.actor_add', { kind: 'woman', name: 'Ada', location: [-1.5, 0, 0] });
    // a 300 m line across the set (a long tether), shrunk by 1e-8 to 3 µm at (0, 0, 1)
    const string = doc.addObject({
      type: 'MESH',
      name: 'Long string',
      data: doc.addMesh(
        'Long string',
        createMesh({ positions: [-150, 0, 0, 150, 0, 0], looseEdges: [0, 1] }),
      ),
      location: [0, 0, 1],
      custom_props: { desk_role: 'string' },
    });
    hideFrom(doc, string, 2);
    const evaluator = new SceneEvaluator(doc);
    const frame = (f: number) =>
      renderDeskFrame(
        { doc, evaluator, simulated: () => null },
        { width: W, height: H, frame: f, cameraId: cam, samples: 1 },
        {
          look: 'material',
          shadows: false,
          ao: false,
          msaa: true,
          passes: ['beauty', 'mask', 'edges', 'pose'],
          objectPalette: { [string]: [255, 255, 255] },
          lines: [{ object: string, width_px: 2, color: [1, 0, 0] }],
        },
      );
    const shown = frame(1).passes!;
    const hidden = frame(2).passes!;
    expect(pixels(shown.mask!, 1, (i) => shown.mask![i] === 1).length).toBeGreaterThan(W);
    expect(pixels(hidden.mask!, 1, (i) => hidden.mask![i] !== 0)).toEqual([]);
    expect(pixels(hidden.edges!, 1, (i) => hidden.edges![i] < 255).every(([x]) => x < W / 3)).toBe(true);
    expect(pixels(hidden.pose!, 3, (i) => hidden.pose![i] > 0 && hidden.pose![i + 1] === 0)).toEqual([]);
  });

  it('say a subject that draws nothing is hidden once a hide key puts it away', () => {
    // a marker (an EMPTY: no geometry of its own, so no box) hidden from frame 2: its world matrix
    // alone tells it is put away
    const doc = SceneDoc.create({ empty: true });
    const cam = doc.addObject({
      type: 'CAMERA',
      name: 'Cam',
      data: doc.addCamera({ lens: 35 }),
      location: [0, -8, 1],
      rotation_euler: [Math.PI / 2, 0, 0],
    });
    doc.addObject({ type: 'MESH', name: 'Box', data: doc.addMesh('Box', createCube({ size: 1 })) });
    const marker = doc.addObject({ type: 'EMPTY', name: 'Marker', location: [1, 0, 1] });
    hideFrom(doc, marker, 2);
    const evaluator = new SceneEvaluator(doc);
    const box = (frame: number) =>
      renderDeskFrame(
        { doc, evaluator, simulated: () => null },
        { width: W, height: H, frame, cameraId: cam, samples: 1 },
        { look: 'material', shadows: false, ao: false, msaa: true, passes: ['beauty'], subjects: [marker] },
      ).meta!.subjects[marker];
    expect(box(1)).toBeNull();
    expect(box(2)).toEqual({ x: 0, y: 0, w: 0, h: 0, visible: false, hidden: true });
  });

  it('keep the visible parts of a subject in its box when some of its parts are hidden', () => {
    const doc = SceneDoc.create({ empty: true });
    const cam = doc.addObject({
      type: 'CAMERA',
      name: 'Cam',
      data: doc.addCamera({ lens: 35 }),
      location: [0, -8, 0],
      rotation_euler: [Math.PI / 2, 0, 0],
    });
    const cube = doc.addMesh('Cube', createCube({ size: 1 }));
    const root = doc.addObject({ type: 'EMPTY', name: 'Kite', location: [0, 0, 0] });
    doc.addObject({ type: 'MESH', name: 'Sail', data: cube, parent: root, location: [-1, 0, 0] });
    // its tail hangs to the right: shrunk to its origin there, it must not widen the box
    const tail = doc.addObject({
      type: 'MESH',
      name: 'Tail',
      data: cube,
      parent: root,
      location: [2.5, 0, 0],
    });
    hideFrom(doc, tail, 2);
    const evaluator = new SceneEvaluator(doc);
    const box = (frame: number) =>
      renderDeskFrame(
        { doc, evaluator, simulated: () => null },
        { width: W, height: H, frame, cameraId: cam, samples: 1 },
        { look: 'material', shadows: false, ao: false, msaa: true, passes: ['beauty'], subjects: [root] },
      ).meta!.subjects[root]!;
    const both = box(1);
    const sail = box(2);
    expect(sail.visible).toBe(true);
    expect(sail.hidden).toBeUndefined();
    expect(sail.x).toBe(both.x);
    // the sail spans 1.5–0.5 m left of the centre: its box ends left of the frame's middle, where
    // the box of both parts went on to the tail 2.5 m right of it
    expect(both.x + both.w).toBeGreaterThan(W * 0.75);
    expect(sail.x + sail.w).toBeLessThan(W / 2);
  });

  it('count in none of a shot’s measurements (shadow box, depth range, occlusion reach)', () => {
    const doc = SceneDoc.create({ empty: true });
    const cam = doc.addObject({
      type: 'CAMERA',
      name: 'Cam',
      data: doc.addCamera({ lens: 35 }),
      location: [0, -6, 1],
      rotation_euler: [Math.PI / 2, 0, 0],
    });
    const cube = doc.addMesh('Cube', createCube({ size: 1 }));
    doc.addObject({ type: 'MESH', name: 'Box', data: cube, location: [0, 0, 0.5] });
    // a kite put away high above the set and its two tail parts: hidden for the whole shot
    const parked: Vec3[] = [
      [0, 0, 30],
      [0.5, 0, 29],
      [1, 0, 28],
    ];
    const hiddenIds = parked.map((location, k) =>
      doc.addObject({
        type: 'MESH',
        name: `Kite part ${k}`,
        data: cube,
        location,
        scale: [1e-8, 1e-8, 1e-8],
      }),
    );
    const evaluator = new SceneEvaluator(doc);
    const info = deskShotInfo(
      { doc, evaluator },
      { frames: [1, 2, 3], cameraId: cam, aspect: 16 / 9 },
      () => {},
    );
    // the box's shadows only: the shadow box ends a little above the box, far below the kite
    expect(info.shadowFit).not.toBeNull();
    expect(info.shadowFit!.max[2]).toBeCloseTo(1.1, 6);
    expect(info.shadowFit!.min[0]).toBeGreaterThan(-5);
    // the occlusion reach of what is seen: the box (not the tiny hidden parts' median)
    const scene = evaluator.evaluate(1, { forRender: true });
    const seen = renderItems(scene, { forRender: true }).filter((o) => !hiddenIds.includes(o.object.id));
    expect(seen).toHaveLength(1);
    expect(info.aoRadius).toBeCloseTo(defaultAoRadius(seen), 9);
    expect(info.aoRadius).toBeGreaterThan(0.3);
  });

  it.each([200, 500])(
    'count a kite string %i m long put away after its flight in none of a shot’s measurements',
    (length_m) => {
      // a box and a crate, and a kite flown on a long string from a hand right of them over frames
      // 1–12, put away after it (after: 'hide'): hidden, its string keeps its length times
      // HIDE_SCALE (2–5 µm, longer than geometry counts as collapsed under), at the hand
      const { doc, run } = deskScene();
      doc.updateScene({ fps: 24, frame_start: 1, frame_end: 40 });
      const cam = doc.addObject({
        type: 'CAMERA',
        name: 'Cam',
        data: doc.addCamera({ lens: 35 }),
        location: [0.5, -8, 1],
        rotation_euler: [Math.PI / 2, 0, 0],
      });
      const boxes = [
        doc.addObject({
          type: 'MESH',
          name: 'Box',
          data: doc.addMesh('Box', createCube({ size: 1 })),
          location: [-1, 0, 0.5],
        }),
        doc.addObject({
          type: 'MESH',
          name: 'Crate',
          data: doc.addMesh('Crate', createCube({ size: 0.5 })),
          location: [0.5, 0, 0.25],
        }),
      ];
      const hand = doc.addObject({ type: 'EMPTY', name: 'Hand', location: [4, 0, 1.2] });
      const kite = run<{ root: string }>('store.add', { model: 'diamond_kite', name: 'Kite' }).root;
      const fly = run<{ string: { object: string } | null; hidden_from: number | null }>('desk.tether_fly', {
        flyer: kite,
        anchor: hand,
        length_m,
        wind_dir_deg: 90,
        wind_mps: 6,
        frame_start: 1,
        frame_end: 12,
        launch_frames: 0,
        after: 'hide',
      });
      expect(fly.hidden_from).toBe(13);
      const string = fly.string!.object;
      let evaluator = new SceneEvaluator(doc);
      const items = (frame: number) =>
        renderItems(evaluator.evaluate(frame, { forRender: true }), { forRender: true });
      const stringAt = (frame: number) => items(frame).find((i) => i.object.id === string)!;
      // flying, the string is seen; put away, it is not, although its geometry is more than a
      // micrometre long (the geometry alone would read it as shown)
      expect(hiddenItem(stringAt(6))).toBe(false);
      const away = stringAt(20);
      expect(hiddenByScale(away.worldMatrix)).toBe(true);
      expect(collapsedBox(evaluatedBounds([away])!)).toBe(false);
      expect(hiddenItem(away)).toBe(true);

      const shot = () =>
        deskShotInfo({ doc, evaluator }, { frames: [20, 30, 40], cameraId: cam, aspect: 16 / 9 }, () => {});
      const info = shot();
      // the box's and the crate's shadows only (the crate's right side at 0.75, then the reach of
      // 2.5 heights of the 1 m box), not the hand's at x = 4, where the string was put away
      expect(info.shadowFit!.max[0]).toBeCloseTo(0.75 + 2.5, 6);
      // the occlusion reach of the two (the median of their sizes), not of a third tiny item
      const seen = items(20).filter((i) => boxes.includes(i.object.id));
      expect(seen).toHaveLength(2);
      expect(info.aoRadius).toBeCloseTo(defaultAoRadius(seen), 9);
      // the same as the scene without the string measures
      doc.removeObject(string);
      evaluator = new SceneEvaluator(doc);
      expect({ ...info, ms: 0 }).toEqual({ ...shot(), ms: 0 });
    },
  );
});

describe('subject tracks of hidden subjects', () => {
  it('record the frames a subject is hidden as hidden, never as a box', () => {
    const t = new ShotTracks();
    const camera = { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], fovY: 0.8 };
    const meta = (box: FrameMeta['subjects'][string]): FrameMeta => ({ camera, subjects: { kite: box } });
    t.add(1, meta({ x: 10, y: 20, w: 30, h: 40, visible: true }));
    t.add(2, meta({ x: 0, y: 0, w: 0, h: 0, visible: false, hidden: true }));
    t.add(3, meta(null));
    expect(t.subjects.get('kite')).toEqual([
      { frame: 1, x: 10, y: 20, w: 30, h: 40, visible: true },
      { frame: 2, x: 0, y: 0, w: 0, h: 0, visible: false, hidden: true },
      { frame: 3, x: 0, y: 0, w: 0, h: 0, visible: false },
    ]);
  });
});

/** An OBJ cube `units` native units across, standing on its base. */
function cubeObj(units: number): string {
  const s = units / 2;
  const v = [
    [-s, -s, 0],
    [s, -s, 0],
    [s, s, 0],
    [-s, s, 0],
    [-s, -s, units],
    [s, -s, units],
    [s, s, units],
    [-s, s, units],
  ];
  return (
    v.map((p) => `v ${p.join(' ')}`).join('\n') +
    '\nf 1 2 3 4\nf 5 8 7 6\nf 1 5 6 2\nf 2 6 7 3\nf 3 7 8 4\nf 4 8 5 1\n'
  );
}

/**
 * Inserts a cube model `units` native units across with store.insert_files, fitted to `height_m`
 * metres as a store model is: its root is scaled to height_m / units. Returns the root's id.
 */
function insertModel(
  run: ReturnType<typeof deskScene>['run'],
  name: string,
  units: number,
  height_m: number,
  location: Vec3,
): string {
  return run<{ root: string }>('store.insert_files', {
    entry: {
      id: `cube-${units}`,
      name,
      provider: 'test',
      license: { spdx: 'CC0-1.0', url: null, attribution: null },
      author: 'test',
      source_url: 'https://example.invalid/cube',
      category: 'props',
    },
    format: 'obj',
    files: { 'cube.obj': Buffer.from(cubeObj(units)).toString('base64') },
    main: 'cube.obj',
    height_m,
    location,
  }).root;
}

describe('store models shown at a tiny world scale in export frames', () => {
  /**
   * A crate in micrometres shown 1 m tall (world scale 1e-6) and a toy kite 10,000,000 units across
   * shown 50 cm tall (5e-8: below hiddenByScale's 1e-7), flown from frame 10 to 20 and put away after
   * it (desk.tether_fly after: 'hide'); before frame 10 it stands at x = 2.
   */
  function toyScene() {
    const { doc, run } = deskScene();
    doc.updateScene({ fps: 24, frame_start: 1, frame_end: 40 });
    const cam = doc.addObject({
      type: 'CAMERA',
      name: 'Cam',
      data: doc.addCamera({ lens: 35 }),
      location: [0.5, -5, 0.5],
      rotation_euler: [Math.PI / 2, 0, 0],
    });
    doc.updateScene({ camera: cam });
    const crate = insertModel(run, 'Crate', 1e6, 1, [-1, 0, 0]);
    const toy = insertModel(run, 'Toy kite', 1e7, 0.5, [2, 0, 0]);
    const hand = doc.addObject({ type: 'EMPTY', name: 'Hand', location: [2, 0, 1.2] });
    const fly = run<{ hidden_from: number | null }>('desk.tether_fly', {
      flyer: toy,
      anchor: hand,
      length_m: 20,
      wind_dir_deg: 90,
      wind_mps: 6,
      frame_start: 10,
      frame_end: 20,
      after: 'hide',
    });
    expect(fly.hidden_from).toBe(21);
    return { doc, cam, crate, toy, evaluator: new SceneEvaluator(doc) };
  }

  it('are drawn, boxed and measured as any other model, and put away by a hide key as any other', () => {
    const s = toyScene();
    expect(s.doc.getObject(s.crate)!.scale[0]).toBeCloseTo(1e-6, 15);
    expect(s.doc.getObject(s.toy)!.scale[0]).toBeCloseTo(5e-8, 18);
    // a world matrix alone reads the toy as collapsed while it is shown: its geometry tells it is not
    const toyPart = (frame: number) =>
      renderItems(s.evaluator.evaluate(frame, { forRender: true }), { forRender: true }).find(
        (i) => i.object.data.parent === s.toy,
      )!;
    expect(hiddenByScale(toyPart(5).worldMatrix)).toBe(true);
    expect([hiddenItem(toyPart(5)), hiddenItem(toyPart(30))]).toEqual([false, true]);

    const frame = (f: number) =>
      renderDeskFrame(
        { doc: s.doc, evaluator: s.evaluator, simulated: () => null },
        { width: W, height: H, frame: f, cameraId: s.cam, samples: 1 },
        {
          look: 'material',
          shadows: false,
          ao: false,
          msaa: true,
          passes: ['beauty', 'mask'],
          // mask indices: the crate 1, the toy 2
          objectPalette: { [s.crate]: [255, 0, 0], [s.toy]: [0, 255, 0] },
          subjects: [s.crate, s.toy],
        },
      );
    const shown = frame(5);
    const hidden = frame(30);
    // frame 5: both are seen, with boxes and mask pixels
    for (const id of [s.crate, s.toy]) {
      expect(shown.meta!.subjects[id]).toMatchObject({ visible: true });
      expect(shown.meta!.subjects[id]!.hidden).toBeUndefined();
    }
    const toyBox = shown.meta!.subjects[s.toy]!;
    expect(toyBox.w).toBeGreaterThan(10);
    expect(toyBox.x).toBeGreaterThan(W / 2);
    const mask5 = shown.passes!.mask!;
    expect(pixels(mask5, 1, (i) => mask5[i] === 1).length).toBeGreaterThan(100);
    expect(pixels(mask5, 1, (i) => mask5[i] === 2).length).toBeGreaterThan(100);
    // frame 30: the toy is put away (after its flight), the crate is not
    expect(hidden.meta!.subjects[s.crate]).toEqual(shown.meta!.subjects[s.crate]);
    expect(hidden.meta!.subjects[s.toy]).toEqual({ x: 0, y: 0, w: 0, h: 0, visible: false, hidden: true });
    const mask30 = hidden.passes!.mask!;
    expect(pixels(mask30, 1, (i) => mask30[i] === 2)).toEqual([]);
    expect(pixels(mask30, 1, (i) => mask30[i] === 1).length).toBe(
      pixels(mask5, 1, (i) => mask5[i] === 1).length,
    );

    // the subject tracks of the manifest: the toy is boxed while shown, hidden after its flight
    const tracks = new ShotTracks();
    tracks.add(5, shown.meta);
    tracks.add(30, hidden.meta);
    expect(tracks.subjects.get(s.toy)).toEqual([
      { frame: 5, ...toyBox },
      { frame: 30, x: 0, y: 0, w: 0, h: 0, visible: false, hidden: true },
    ]);

    // the shot's shadow box reaches the toy while it stands at x = 2 (its right side at 2.25, then
    // the shadows' reach of 2.5 heights of the 1 m crate), and the crate alone once it is put away
    const shot = (frames: number[]) =>
      deskShotInfo(
        { doc: s.doc, evaluator: s.evaluator },
        { frames, cameraId: s.cam, aspect: W / H },
        () => {},
      );
    expect(shot([1, 3, 5]).shadowFit!.max[0]).toBeCloseTo(2.25 + 2.5, 6);
    expect(shot([25, 30, 35]).shadowFit!.max[0]).toBeCloseTo(-0.5 + 2.5, 6);
  });

  it('hiddenItem: geometry collapsed to under a micrometre, whatever scale it is shown at', () => {
    const at = (scale: Vec3): Mat4 => [scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, 1, 2, 3, 1];
    const cube = (size: number) => ({ mesh: createCube({ size }) });
    const s3 = (k: number): Vec3 => [k, k, k];
    // shown: at scale 1, a 2 m model in micrometres at 1e-6, a 50 cm one in very large units at 5e-8
    expect(hiddenItem({ ...cube(2), worldMatrix: at(s3(1)) })).toBe(false);
    expect(hiddenItem({ ...cube(2e6), worldMatrix: at(s3(1e-6)) })).toBe(false);
    expect(hiddenByScale(at(s3(5e-8)))).toBe(true);
    expect(5e-8).toBeLessThan(HIDDEN_SCALE_EPS);
    expect(hiddenItem({ ...cube(1e7), worldMatrix: at(s3(5e-8)) })).toBe(false);
    // put away: HIDE_SCALE times the scale it is shown at, and the absolute 1e-8 of earlier versions
    expect(hiddenItem({ ...cube(1e7), worldMatrix: at(s3(hiddenScale(5e-8))) })).toBe(true);
    expect(hiddenItem({ ...cube(2e6), worldMatrix: at(s3(hiddenScale(1e-6))) })).toBe(true);
    expect(hiddenItem({ ...cube(2), worldMatrix: at(s3(1e-8)) })).toBe(true);
    // flattened along one axis is still drawn
    expect(hiddenItem({ ...cube(2), worldMatrix: at([1, 1, 0]) })).toBe(false);
    // a string (desk_role 'string': a 1 m mesh scaled along its length) by its world matrix: put
    // away, one 500 m long is still 5 µm long, more than geometry counts as collapsed under
    const string = { ...cube(1), data: { custom_props: { desk_role: 'string' } } };
    expect(hiddenItem({ ...string, worldMatrix: at([1e-8, 1e-8, 5e-6]) })).toBe(true);
    expect(hiddenItem({ ...cube(1), worldMatrix: at([1e-8, 1e-8, 5e-6]) })).toBe(false);
    expect(hiddenItem({ ...string, worldMatrix: at([1, 1, 500]) })).toBe(false);
    expect(hiddenItem({ ...string, worldMatrix: at(s3(1e-8)) })).toBe(true);
    // the world box given decides; without vertices, the world matrix alone
    expect(hiddenItem({ worldMatrix: at(s3(1e-6)) }, { min: [0, 0, 0], max: [1, 0, 0] })).toBe(false);
    expect(hiddenItem({ worldMatrix: at(s3(1e-6)) }, { min: [0, 0, 0], max: [1e-7, 0, 0] })).toBe(true);
    expect(hiddenItem({ mesh: createMesh({ positions: [] }), worldMatrix: at(s3(1e-8)) })).toBe(true);
    expect(hiddenItem({ worldMatrix: at(s3(1e-6)) }, null)).toBe(false);
    expect(hiddenItem({ worldMatrix: at(s3(1e-8)) }, null)).toBe(true);
  });
});
