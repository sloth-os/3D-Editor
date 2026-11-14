import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  createCube,
  createEditorState,
  createFCurve,
  createMesh,
  createOperatorRegistry,
  defaultAoRadius,
  hiddenByScale,
  insertKeyframe,
  renderItems,
  type FCurve,
  type OperatorContext,
  type Vec3,
} from '@3d-editor/core';
import { deskShotInfo, renderDeskFrame } from '../../src/render/desk';
import type { DeskFrameOptions, FrameMeta } from '../../src/render/protocol';
import { ShotTracks } from '../../src/video/manifest';

/*
 * Objects hidden by their scale in video export frames (render/desk.ts): desk.tether_fly's
 * after: 'hide' and the rideo import shrink what should not be seen to a point (scale 1e-8 keys,
 * core hiddenByScale). Such an object draws nothing in any pass (no skeleton for a shrunk actor, no
 * string line, nothing in the mask or edges), its subject box says hidden instead of a 1 px box at
 * the point it shrank to, and it counts in none of a shot's measurements.
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
