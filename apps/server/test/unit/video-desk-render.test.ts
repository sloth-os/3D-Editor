import { describe, expect, it, vi } from 'vitest';
import * as core from '@3d-editor/core';
import { SceneDoc, SceneEvaluator, createCube, type Vec3 } from '@3d-editor/core';
import { OPENPOSE_COLORS } from '../../src/render/passes';
import type { DeskFrameOptions, PassName } from '../../src/render/protocol';

/*
 * Director's desk frames as the render process makes them (render/desk.ts): the beauty image and
 * the passes from one rasterizer evaluation, strings drawn as lines into the passes, actors'
 * skeletons in the pose pass (core actorKeypoints is replaced here: the characters' keypoints are
 * another workstream's), the camera and subject boxes, and the shot measurements.
 */

const keypoints = vi.hoisted(() => ({ fn: null as null | ((...a: unknown[]) => unknown) }));
/** The options of each core software render (to see what a desk frame asks the renderer for). */
const renders = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock('@3d-editor/core', async (importOriginal) => {
  const orig = await importOriginal<typeof core>();
  return {
    ...orig,
    actorKeypoints: (...a: Parameters<typeof orig.actorKeypoints>) =>
      keypoints.fn ? keypoints.fn(...a) : orig.actorKeypoints(...a),
    renderSceneSoftware: (...a: Parameters<typeof orig.renderSceneSoftware>) => {
      renders.options.push(a[1] as unknown as Record<string, unknown>);
      return orig.renderSceneSoftware(...a);
    },
  };
});

const { renderDeskFrame, deskShotInfo, sampleShotFrames, boxDistances, deskAovs, deskRenderOptions } =
  await import('../../src/render/desk');

const W = 64;
const H = 36;

/** A cube at the origin, a camera 10 m in front of it (looking +Y), a thin string 7 m from the camera, an actor. */
function scene() {
  const doc = SceneDoc.create();
  const cube = doc.listObjects().find((o) => o.type === 'MESH')!.id;
  let cam = '';
  let string = '';
  let actor = '';
  doc.transact(() => {
    for (const o of doc.listObjects()) if (o.type === 'CAMERA') doc.removeObject(o.id);
    cam = doc.addObject({
      type: 'CAMERA',
      name: 'Cam',
      data: doc.addCamera({ lens: 50 }),
      location: [0, -10, 0],
      rotation_euler: [Math.PI / 2, 0, 0],
    });
    doc.updateScene({ camera: cam });
    doc.updateRender({ resolution_x: W, resolution_y: H, resolution_percentage: 100 });
    doc.updateObject(cube, { custom_props: { desk_role: 'prop' } });
    string = doc.addObject({
      type: 'MESH',
      name: 'Kite string',
      data: doc.addMesh('String', createCube({ size: 1 })),
      location: [0, -3, 0.3],
      scale: [6, 0.004, 0.004],
      custom_props: { desk_role: 'string' },
    });
    actor = doc.addObject({
      type: 'ARMATURE',
      name: 'Anna',
      data: doc.addArmature({}),
      custom_props: { desk_role: 'actor', desk_color: '#3d8bff' },
    });
  });
  return { doc, cube, cam, string, actor, evaluator: new SceneEvaluator(doc) };
}

function desk(
  s: ReturnType<typeof scene>,
  passes: PassName[],
  patch: Partial<DeskFrameOptions> = {},
): DeskFrameOptions {
  return {
    look: 'material',
    shadows: false,
    ao: false,
    msaa: true,
    passes,
    depthRange: [5, 15],
    objectPalette: { [s.cube]: [255, 0, 0], [s.string]: [0, 255, 0] },
    subjects: [s.cube],
    poseActors: [s.actor],
    lines: [{ object: s.string, width_px: 2, color: [1, 0, 0] }],
    ...patch,
  };
}

const render = (s: ReturnType<typeof scene>, d: DeskFrameOptions) =>
  renderDeskFrame(
    { doc: s.doc, evaluator: s.evaluator, simulated: () => null },
    { width: W, height: H, frame: 1, cameraId: s.cam, samples: 1 },
    d,
  );

const at = (buf: Uint8Array, x: number, y: number, ch = 1) => [
  ...buf.subarray((y * W + x) * ch, (y * W + x) * ch + ch),
];

/** Rows of column `x` where `buf` (one byte per pixel) has `value`. */
const rowsWith = (buf: Uint8Array, x: number, value: number) =>
  Array.from({ length: H }, (_, y) => y).filter((y) => buf[y * W + x] === value);

describe('desk frames', () => {
  it('renders the beauty image and every pass from one evaluation', () => {
    const s = scene();
    keypoints.fn = () => {
      throw new Error('keypoints are not implemented yet');
    };
    const img = render(s, desk(s, ['beauty', 'depth', 'normal', 'mask', 'edges', 'pose']));
    keypoints.fn = null;
    expect(img.width).toBe(W);
    expect(img.data).toHaveLength(W * H * 4);
    // every pass asked for (their lengths are checked first)
    const p = img.passes as Record<PassName, Uint8Array>;
    expect(p.depth).toHaveLength(W * H);
    expect(p.normal).toHaveLength(W * H * 3);
    expect(p.mask).toHaveLength(W * H);
    expect(p.edges).toHaveLength(W * H);
    expect(p.pose).toHaveLength(W * H * 3);
    const cx = W / 2;
    const cy = H / 2 + 2; // below the string
    // depth: the cube's front face 9 m away in the shot's range 5–15 m, inverse depth
    const expected = Math.round(((1 / 9 - 1 / 15) / (1 / 5 - 1 / 15)) * 255);
    expect(Math.abs(at(p.depth, cx, cy)[0] - expected)).toBeLessThanOrEqual(2);
    expect(at(p.depth, 1, 1)).toEqual([0]); // background
    // normal: facing the camera
    const n = at(p.normal, cx, cy, 3);
    expect(n[2]).toBeGreaterThan(250);
    expect(Math.abs(n[0] - 128)).toBeLessThanOrEqual(2);
    expect(at(p.normal, 1, 1, 3)).toEqual([0, 0, 0]);
    // mask: the cube's palette index (1), nothing (0) around it
    expect(at(p.mask, cx, cy)).toEqual([1]);
    expect(at(p.mask, 1, 1)).toEqual([0]);
    // the string: a line at least 2 px wide in front of the cube, index 2, above the centre
    const stringRows = rowsWith(p.mask, cx, 2);
    expect(stringRows.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...stringRows)).toBeLessThan(H / 2);
    // it spans the frame (6 m wide at 7 m), also over the background
    expect(rowsWith(p.mask, 2, 2).length).toBeGreaterThanOrEqual(2);
    // edges: white inside the cube, black on its outline and on the string
    expect(at(p.edges, cx, cy)).toEqual([255]);
    expect(rowsWith(p.edges, cx, 0).length).toBeGreaterThanOrEqual(2);
    for (const y of stringRows) expect(at(p.edges, cx, y)).toEqual([0]);
    // pose: the actor's keypoints failed: black but for the string in its colour, one warning
    expect(at(p.pose, cx, cy, 3)).toEqual([0, 0, 0]);
    expect(at(p.pose, cx, stringRows[0], 3)[0]).toBeGreaterThan(100);
    expect(img.warnings).toEqual(['pose pass: keypoints are not implemented yet']);
    // the beauty image has the string drawn in red over the cube
    const b = at(img.data as unknown as Uint8Array, cx, stringRows[0], 4);
    expect(b[0]).toBeGreaterThan(b[1] + 40);
  });

  it('reports the camera and the subjects’ boxes', () => {
    const s = scene();
    const img = render(s, desk(s, ['beauty']));
    expect(img.passes).toBeUndefined();
    const cam = img.meta!.camera;
    expect(cam.matrix.slice(12, 15).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, -10, 0]);
    // looking along +Y
    expect(-cam.matrix[9]).toBeCloseTo(1, 6);
    expect(cam.fovY).toBeGreaterThan(0.2);
    expect(cam.fovY).toBeLessThan(0.8);
    const box = img.meta!.subjects[s.cube]!;
    expect(box.visible).toBe(true);
    expect(Math.abs(box.x + box.w / 2 - W / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y + box.h / 2 - H / 2)).toBeLessThanOrEqual(1);
    expect(box.w).toBeGreaterThan(10);
    // a subject that is not drawn: null
    const none = render(s, desk(s, ['beauty'], { subjects: ['NoSuchObject000'] }));
    expect(none.meta!.subjects.NoSuchObject000).toBeNull();
  });

  it('draws the actors’ skeletons in OpenPose colours', () => {
    const s = scene();
    // a neck and a right shoulder in front of the cube (the camera looks along +Y)
    const points: (Vec3 | null)[] = Array.from({ length: 18 }, () => null);
    points[1] = [0, -2, 0];
    points[2] = [-0.6, -2, -0.1];
    keypoints.fn = () => ({ format: 'openpose18', points });
    const img = render(s, desk(s, ['pose'], { lines: [] }));
    keypoints.fn = null;
    expect(img.warnings).toBeUndefined();
    const pose = img.passes!.pose!;
    // the neck joint at the image centre (a pixel corner: the four pixels around it share it), in
    // keypoint 1's colour
    const [r, g, b] = OPENPOSE_COLORS[1];
    for (let y = H / 2 - 1; y <= H / 2; y++)
      for (let x = W / 2 - 1; x <= W / 2; x++) {
        const c = at(pose, x, y, 3);
        expect(c[0]).toBeGreaterThan(0.75 * r);
        expect(Math.abs(c[1] / c[0] - g / r)).toBeLessThan(0.1);
        expect(c[2]).toBe(b);
      }
    // the limb to the right shoulder (to the left on screen) in limb 0's colour, 60 %
    const limb = at(pose, W / 2 - 4, H / 2, 3);
    expect(limb[0]).toBeGreaterThan(100);
    expect(limb[2]).toBe(0);
    expect(at(pose, 2, 2, 3)).toEqual([0, 0, 0]);
  });

  it('draws real actors’ keypoints: a humanoid and a quadruped inside their boxes', () => {
    const doc = SceneDoc.create();
    const size = 128;
    let cam = '';
    const actors: string[] = [];
    doc.transact(() => {
      for (const o of doc.listObjects()) doc.removeObject(o.id);
      cam = doc.addObject({
        type: 'CAMERA',
        name: 'Cam',
        data: doc.addCamera({ lens: 50 }),
        location: [0, -6, 1],
        rotation_euler: [Math.PI / 2, 0, 0],
      });
      doc.updateScene({ camera: cam });
      for (const [kind, x] of [
        ['woman', -0.8],
        ['dog', 0.8],
      ] as const)
        actors.push(core.createActor(doc, { kind, location: [x, 0, 0], facing_deg: 0 }).actor);
    });
    const img = renderDeskFrame(
      { doc, evaluator: new SceneEvaluator(doc), simulated: () => null },
      { width: size, height: size, frame: 1, cameraId: cam, samples: 1 },
      {
        look: 'material',
        shadows: false,
        ao: false,
        msaa: true,
        passes: ['pose'],
        subjects: actors,
        poseActors: actors,
      },
    );
    expect(img.warnings).toBeUndefined();
    const pose = img.passes!.pose!;
    const px = (x: number, y: number) => [...pose.subarray((y * size + x) * 3, (y * size + x) * 3 + 3)];
    const joints = new Set(OPENPOSE_COLORS.map((c) => c.join(',')));
    const boxes = actors.map((id) => img.meta!.subjects[id]!);
    const spans = boxes.map(() => ({ top: Infinity, bottom: -Infinity, joints: 0 }));
    let drawn = 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const c = px(x, y);
        if (!c[0] && !c[1] && !c[2]) continue;
        drawn++;
        // every skeleton pixel lies in its actor's box (a joint's radius around it)
        const k = boxes.findIndex(
          (b) => x >= b.x - 3 && x <= b.x + b.w + 3 && y >= b.y - 3 && y <= b.y + b.h + 3,
        );
        expect(k).toBeGreaterThanOrEqual(0);
        const s = spans[k];
        s.top = Math.min(s.top, y);
        s.bottom = Math.max(s.bottom, y);
        if (joints.has(c.join(','))) s.joints++;
      }
    expect(drawn).toBeGreaterThan(100);
    boxes.forEach((b, k) => {
      expect(b.visible).toBe(true);
      // each skeleton spans most of its actor's height, its joints in OpenPose colours
      expect(spans[k].bottom - spans[k].top).toBeGreaterThan(0.6 * b.h);
      expect(spans[k].joints).toBeGreaterThan(4);
    });
  });

  it('renders frames without their beauty image unlit by shadows and AO, with the very same passes', () => {
    const s = scene();
    const passes: PassName[] = ['depth', 'normal', 'mask', 'edges', 'pose'];
    const lit = { shadows: true, ao: true };
    renders.options.length = 0;
    const full = render(s, desk(s, ['beauty', ...passes], lit));
    const only = render(s, desk(s, passes, lit));
    expect(renders.options).toHaveLength(2);
    expect(renders.options[0]).toMatchObject({ shadows: true, ao: true, look: 'material' });
    expect(renders.options[0].lines).toBeDefined();
    // shadows and ambient occlusion only change colours, and the strings are drawn into the image
    expect(renders.options[1]).toMatchObject({ shadows: false, ao: false, look: 'material', samples: 1 });
    expect(renders.options[1].lines).toBeUndefined();
    expect(only.data).toBeUndefined();
    for (const p of passes)
      expect(Buffer.from(only.passes![p]!).equals(Buffer.from(full.passes![p]!)), p).toBe(true);
    expect(only.meta).toEqual(full.meta);
    // a pose pass without strings needs no rasterizing at all: the skeletons come from the evaluation
    renders.options.length = 0;
    const pose = render(s, desk(s, ['pose'], { ...lit, lines: [] }));
    expect(renders.options).toHaveLength(0);
    expect(pose.passes?.pose).toHaveLength(W * H * 3);
    expect(pose.width).toBe(W);
    const cam = pose.meta!.camera;
    cam.matrix.forEach((v, i) => expect(v).toBeCloseTo(full.meta!.camera.matrix[i], 9));
    expect(cam.fovY).toBeCloseTo(full.meta!.camera.fovY, 9);
    expect(pose.meta!.subjects).toEqual(full.meta!.subjects);
    // the options themselves
    const d = desk(s, ['depth'], lit);
    const base = { width: W, height: H, samples: 2 };
    expect(deskRenderOptions(base, d)).toMatchObject({ shadows: true, ao: true, samples: 2 });
    expect(deskRenderOptions(base, d, false)).toMatchObject({
      shadows: false,
      ao: false,
      samples: 2,
      msaa: true,
      look: 'material',
    });
  });

  it('asks the renderer only for the per-pixel passes it needs', () => {
    expect(deskAovs(new Set(['beauty']), false)).toEqual([]);
    expect(deskAovs(new Set(['depth']), false)).toEqual(['depth']);
    expect(deskAovs(new Set(['mask']), false)).toEqual(['object']);
    expect(deskAovs(new Set(['mask']), true)).toEqual(['depth', 'object']);
    expect(deskAovs(new Set(['edges']), false)).toEqual(['depth', 'normal', 'object']);
    expect(deskAovs(new Set(['pose']), true)).toEqual(['depth']);
  });
});

describe('shot measurements', () => {
  it('measures the depth range the camera sees and a stable shadow box', () => {
    const s = scene();
    const sims: number[] = [];
    const info = deskShotInfo(
      { doc: s.doc, evaluator: s.evaluator },
      { frames: [1, 2, 3], cameraId: s.cam, aspect: W / H },
      (f) => sims.push(f),
    );
    // the cube's front face is 9 m away (with margins)
    expect(info.depthRange[0]).toBeLessThan(9);
    expect(info.depthRange[0]).toBeGreaterThan(5);
    expect(info.depthRange[1]).toBeGreaterThan(9);
    expect(info.depthRange[1]).toBeLessThan(15);
    expect(info.shadowFit).not.toBeNull();
    const fit = info.shadowFit!;
    for (let k = 0; k < 3; k++) {
      expect(fit.min[k]).toBeLessThanOrEqual(-1);
      expect(fit.max[k]).toBeGreaterThanOrEqual(1);
    }
    expect(sims).toEqual([1, 2, 3]);
    expect(() =>
      deskShotInfo(
        { doc: s.doc, evaluator: s.evaluator },
        { frames: [1], cameraId: 'Nope', aspect: 1 },
        () => {},
      ),
    ).toThrow(/Camera 'Nope' not found/);
  });

  it('samples frames evenly and measures box distances', () => {
    expect(sampleShotFrames([1, 2, 3])).toEqual([1, 2, 3]);
    const many = sampleShotFrames(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(many).toHaveLength(8);
    expect(many[0]).toBe(1);
    expect(many.at(-1)).toBe(100);
    expect(
      boxDistances([0, -10, 0], [-1, -1, -1], [1, 1, 1]).map((v) => Math.round(v * 1000) / 1000),
    ).toEqual([9, Math.round(Math.hypot(1, 11, 1) * 1000) / 1000]);
    expect(boxDistances([0, 0, 0], [-1, -1, -1], [1, 1, 1])[0]).toBe(0);
  });
});
