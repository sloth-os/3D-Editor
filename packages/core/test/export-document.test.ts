import { describe, expect, it } from 'vitest';
import { SceneDoc, SceneEvaluator, createCube, defaultRigidBody } from '../src';
import { renderDeskFrame } from '../src/export/desk-frame';
import {
  createExportRenderDocument,
  exportRenderDocumentFromUpdate,
  measureDeskShot,
  physicsMatrices,
  renderExportFrame,
  simulateRigidBodies,
  simulatesRigidBodies,
  softwareOptions,
  useFramePhysics,
} from '../src/export/document';
import type { DeskFrameOptions, FrameOptions } from '../src/export/protocol';

/*
 * The render document of a render thread (the server's render processes and the browser's render
 * workers): the rigid bodies simulated once and shared with every thread for the frame they came
 * with, the shot measurement without the simulation, and a frame rendered exactly as desk-frame.ts
 * renders it.
 */

/** The default scene with a falling cube (an active rigid body 3 m up). */
function fallingCube(): { doc: SceneDoc; cube: string; cam: string } {
  const doc = SceneDoc.create();
  const cam = doc.listObjects().find((o) => o.type === 'CAMERA')!.id;
  const cube = doc.addObject({
    type: 'MESH',
    name: 'Falling',
    data: doc.addMesh('Falling', createCube({ size: 0.5 })),
    location: [0, 0, 3],
    rigid_body: defaultRigidBody('ACTIVE'),
  });
  doc.transact(() => doc.updateScene({ camera: cam }));
  return { doc, cube, cam };
}

const desk = (passes: DeskFrameOptions['passes']): DeskFrameOptions => ({
  look: 'clay',
  shadows: true,
  ao: false,
  msaa: true,
  passes,
});

const frame = (n: number, extra: Partial<FrameOptions> = {}): FrameOptions & { desk: DeskFrameOptions } => ({
  width: 48,
  height: 27,
  frame: n,
  engine: 'RASTER',
  samples: 1,
  desk: desk(['beauty', 'depth']),
  ...extra,
});

describe('export render documents', () => {
  it('simulate the rigid bodies of some frames once, in frame order, for every thread', () => {
    const { doc, cube } = fallingCube();
    expect(simulatesRigidBodies(doc)).toBe(true);
    const entry = createExportRenderDocument(doc);
    const sim = simulateRigidBodies(entry, [20, 1, 10]);
    expect(sim.frames.map((f) => f.frame)).toEqual([1, 10, 20]);
    // nothing is simulated at the world's first frame
    expect(sim.frames[0].ids).toEqual([]);
    for (const f of sim.frames.slice(1)) {
      expect(f.ids).toEqual([cube]);
      expect(f.matrices).toHaveLength(16);
    }
    // the cube falls
    const z = sim.frames.slice(1).map((f) => f.matrices[14]);
    expect(z[0]).toBeLessThan(3);
    expect(z[1]).toBeLessThan(z[0]);
    const m = physicsMatrices(sim.frames[2])!;
    expect([...m.keys()]).toEqual([cube]);
    expect(m.get(cube)).toEqual([...sim.frames[2].matrices]);
    expect(physicsMatrices({ frame: 3, ids: [], matrices: new Float64Array(0) })).toBeNull();
    const still = SceneDoc.create();
    expect(simulatesRigidBodies(still)).toBe(false);
  });

  it('render a frame with the matrices shared with it, only for the frame they came with', () => {
    const { doc, cube } = fallingCube();
    const entry = createExportRenderDocument(doc);
    const [shared] = simulateRigidBodies(entry, [20]).frames;
    // matrices of another place (the cube held in front of the scene's cube, in view) replace the
    // simulation at frame 20
    const held = {
      frame: 20,
      ids: [cube],
      matrices: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1.5, -2.5, 0.5, 1]),
    };
    useFramePhysics(entry, { frame: 20, physics: held });
    expect(entry.physics?.frame).toBe(20);
    const scene = entry.evaluator.evaluate(20, { forRender: true });
    expect(scene.byId.get(cube)!.worldMatrix[14]).toBe(0.5);
    // physics of another frame do not apply
    useFramePhysics(entry, { frame: 21, physics: held });
    expect(entry.physics).toBeNull();
    // a frame rendered with the shared matrices is the frame the thread simulates itself
    const own = renderExportFrame(createExportRenderDocument(doc), frame(20));
    const withShared = renderExportFrame(createExportRenderDocument(doc), frame(20, { physics: shared }));
    expect(withShared.data).toEqual(own.data);
    expect(withShared.passes?.depth).toEqual(own.passes?.depth);
    // and the held cube shows somewhere else
    const moved = renderExportFrame(createExportRenderDocument(doc), frame(20, { physics: held }));
    expect(moved.passes?.depth).not.toEqual(own.passes?.depth);
  });

  it('render exactly what desk-frame.ts renders, from a snapshot update too', () => {
    const { doc } = fallingCube();
    const options = frame(12, { desk: desk(['beauty', 'depth', 'normal', 'mask', 'edges', 'pose']) });
    const viaDocument = renderExportFrame(exportRenderDocumentFromUpdate(doc.encodeState()), options);
    const evaluator = new SceneEvaluator(doc);
    const direct = renderDeskFrame(
      { doc, evaluator, simulated: () => null },
      { ...softwareOptions(options), frame: options.frame },
      options.desk,
    );
    expect(viaDocument.data).toEqual(direct.data);
    for (const p of ['depth', 'normal', 'mask', 'edges', 'pose'] as const)
      expect(viaDocument.passes?.[p], p).toEqual(direct.passes?.[p]);
    expect(viaDocument.meta).toEqual(direct.meta);
    // with `png` the beauty image comes back as a PNG file
    const png = renderExportFrame(createExportRenderDocument(doc), options, true);
    expect(png.data).toBeUndefined();
    expect([...png.png!.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('measure a shot without the simulation, and leave no physics behind', () => {
    const { doc, cam } = fallingCube();
    const entry = createExportRenderDocument(doc);
    entry.physics = { frame: 1, matrices: null };
    const info = measureDeskShot(entry, { frames: [1, 5, 10], cameraId: cam, aspect: 16 / 9 });
    expect(info.depthRange[0]).toBeLessThan(info.depthRange[1]);
    expect(info.shadowFit).not.toBeNull();
    expect(entry.physics).toBeNull();
    expect(() => measureDeskShot(entry, { frames: [1], cameraId: 'nope', aspect: 1 })).toThrow(/not found/);
    expect(entry.physics).toBeNull();
  });

  it('convert frame options to the software renderer options, the engine always explicit', () => {
    expect(
      softwareOptions({ width: 10, height: 8, frame: 3, engine: 'RASTER', cameraId: 'c', samples: 2 }),
    ).toMatchObject({
      width: 10,
      height: 8,
      frame: 3,
      engine: 'RASTER',
      cameraId: 'c',
      samples: 2,
      view: undefined,
    });
    expect(
      softwareOptions({
        width: 1,
        height: 1,
        frame: 1,
        engine: 'PATHTRACER',
        view: { position: [1, 2, 3], target: [0, 0, 0] },
      }).view,
    ).toEqual({ position: [1, 2, 3], target: [0, 0, 0], up: undefined, fovY: undefined });
  });
});
