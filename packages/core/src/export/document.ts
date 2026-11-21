import { SceneDoc } from '../doc/scene-doc';
import { SceneEvaluator } from '../eval/evaluate';
import type { Mat4 } from '../math/types';
import type { RigidBodyHost } from '../physics/rigid-body';
import type { SoftwareRenderOptions } from '../render';
import { deskShotInfo, renderDeskFrame } from './desk-frame';
import type {
  DeskFrameOptions,
  DeskShotInfo,
  DeskShotOptions,
  FrameOptions,
  ImageResult,
  PhysicsFrame,
  SimulatedFrames,
} from './protocol';

/*
 * The document a render thread renders the frames of a video export from, and the three things an
 * export asks of a thread: measure a shot (`measureDeskShot`), simulate the rigid bodies of some
 * frames once for every thread (`simulateRigidBodies`) and render a frame with its passes and
 * metadata (`renderExportFrame`). The server's render processes (apps/server/src/render/engine.ts)
 * and the browser export's render workers (apps/web/src/export) call these functions, so that both
 * render an export the same way.
 */

/** A document of a render thread with its evaluator (geometry and simulation caches) and physics. */
export interface ExportRenderDocument {
  doc: SceneDoc;
  evaluator: SceneEvaluator;
  /**
   * Rigid body matrices of the frame being rendered, simulated once for every thread (see
   * `FrameOptions.physics`): the evaluator uses them instead of simulating. Null: it simulates.
   */
  physics: { frame: number; matrices: Map<string, Mat4> | null } | null;
}

/**
 * A render document of `doc`: a new evaluator whose rigid body simulation answers with the
 * document's `physics` when they are of the frame asked for (matrices simulated once for every
 * thread replace the simulation), else simulates as usual.
 */
export function createExportRenderDocument(doc: SceneDoc): ExportRenderDocument {
  const entry: ExportRenderDocument = { doc, evaluator: new SceneEvaluator(doc), physics: null };
  const sim = entry.evaluator.rigidBodies;
  const simulate = sim.evaluate.bind(sim);
  sim.evaluate = (d, frame, host) =>
    entry.physics && entry.physics.frame === frame ? entry.physics.matrices : simulate(d, frame, host);
  return entry;
}

/** A render document of the document a Yjs state update holds (an export's snapshot). */
export function exportRenderDocumentFromUpdate(update: Uint8Array): ExportRenderDocument {
  return createExportRenderDocument(SceneDoc.fromUpdate(update));
}

/** The world matrices of a physics frame by object id (null: nothing simulated at the frame). */
export function physicsMatrices(p: PhysicsFrame): Map<string, Mat4> | null {
  if (!p.ids.length) return null;
  const out = new Map<string, Mat4>();
  p.ids.forEach((id, i) => out.set(id, Array.from(p.matrices.subarray(i * 16, i * 16 + 16)) as Mat4));
  return out;
}

/** Whether evaluating the scene runs the rigid body simulation (as `SceneEvaluator` decides). */
export function simulatesRigidBodies(doc: SceneDoc): boolean {
  return !!doc.getScene().rigidbody_world?.enabled && doc.listObjects().some((o) => o.rigid_body?.enabled);
}

/** The scene access the rigid body simulator needs (as `SceneEvaluator.evaluate` provides it). */
export function rigidBodyHost(doc: SceneDoc, evaluator: SceneEvaluator): RigidBodyHost {
  return {
    transformsAt: (f) => evaluator.transformsAt(f),
    meshOf: (id) => {
      const o = doc.getObject(id);
      return o?.type === 'MESH' && o.data ? doc.getMesh(o.data) : null;
    },
  };
}

/**
 * Converts frame options to the core software renderer options (engine always explicit). The desk
 * options of video exports (`o.desk`) are added by desk-frame.ts.
 */
export function softwareOptions(o: FrameOptions): SoftwareRenderOptions {
  return {
    width: o.width,
    height: o.height,
    frame: o.frame,
    engine: o.engine,
    cameraId: o.cameraId,
    view: o.view
      ? { position: o.view.position, target: o.view.target, up: o.view.up, fovY: o.view.fovY }
      : undefined,
    shading: o.shading,
    wireframe: o.wireframe,
    samples: o.samples,
    max_bounces: o.max_bounces,
    denoise: o.denoise,
    time_limit: o.time_limit,
    seed: o.seed,
    background: o.background,
  };
}

/**
 * Sets the document up to use the physics of `options` (if any) for its frame: shared physics only
 * apply to the render they came with.
 */
export function useFramePhysics(
  entry: ExportRenderDocument,
  options: Pick<FrameOptions, 'frame' | 'physics'>,
): void {
  const p = options.physics;
  entry.physics = p && p.frame === options.frame ? { frame: p.frame, matrices: physicsMatrices(p) } : null;
}

/**
 * Simulates the rigid body world up to `frames` (incrementally, cached per document like every
 * evaluation) and returns the world matrices of the simulated objects at each of them. A frame
 * whose simulation fails ends the list: the threads rendering the frames left out simulate them
 * themselves (and report the error).
 */
export function simulateRigidBodies(entry: ExportRenderDocument, frames: readonly number[]): SimulatedFrames {
  const t0 = performance.now();
  const { doc, evaluator } = entry;
  entry.physics = null;
  const host = rigidBodyHost(doc, evaluator);
  const out: PhysicsFrame[] = [];
  for (const frame of [...frames].sort((a, b) => a - b)) {
    let m: Map<string, Mat4> | null;
    try {
      m = evaluator.rigidBodies.evaluate(doc, frame, host);
    } catch {
      // frames left out are simulated (and the error reported) by the threads rendering them
      break;
    }
    const ids = m ? [...m.keys()] : [];
    const matrices = new Float64Array(ids.length * 16);
    ids.forEach((id, i) => matrices.set(m!.get(id)!, i * 16));
    out.push({ frame, ids, matrices });
  }
  return { frames: out, ms: performance.now() - t0 };
}

/**
 * Measures one shot of a video export (desk-frame.ts deskShotInfo): its depth range, shadow box and
 * occlusion reach. The samples are evaluated without the rigid body simulation.
 */
export function measureDeskShot(entry: ExportRenderDocument, options: DeskShotOptions): DeskShotInfo {
  entry.physics = null;
  try {
    return deskShotInfo(entry, options, (frame) => {
      entry.physics = { frame, matrices: null };
    });
  } finally {
    entry.physics = null;
  }
}

/**
 * Renders one frame of a video export (desk-frame.ts renderDeskFrame): the beauty image (or its
 * PNG with `png`), the passes and the metadata, with the frame's shared physics when it has them
 * (else the thread's own cached simulation).
 */
export function renderExportFrame(
  entry: ExportRenderDocument,
  options: FrameOptions & { desk: DeskFrameOptions },
  png = false,
): ImageResult {
  useFramePhysics(entry, options);
  const { doc, evaluator } = entry;
  return renderDeskFrame(
    {
      doc,
      evaluator,
      simulated: (frame) => {
        if (!simulatesRigidBodies(doc)) return null;
        try {
          // the frame's shared matrices (FrameOptions.physics), else the thread's cached simulation
          return evaluator.rigidBodies.evaluate(doc, frame, rigidBodyHost(doc, evaluator));
        } catch {
          return null;
        }
      },
    },
    { ...softwareOptions(options), frame: options.frame },
    options.desk,
    png,
  );
}
