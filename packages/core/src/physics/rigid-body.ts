import type { Mat4 } from '../math/types';
import type { MeshData } from '../mesh/types';
import type { SceneDoc } from '../doc/scene-doc';

/** Callbacks the simulator uses to read the scene. */
export interface RigidBodyHost {
  /** Unsimulated world matrices of all objects at a frame (animation, parenting, constraints). */
  transformsAt(frame: number): Map<string, Mat4>;
  /** Object-space mesh used to build collision shapes (null for non-mesh objects). */
  meshOf(id: string): MeshData | null;
}

/**
 * Rigid body world simulation with an incremental frame cache (like Blender's point cache):
 * the cache is invalidated when simulation inputs change and re-simulated from frame_start.
 *
 * Phase-0 stub: never simulates. The physics workstream implements it.
 */
export class RigidBodySimulator {
  /**
   * Simulated world matrices at `frame` for ACTIVE (non-animated) bodies, or null when the rigid
   * body world is disabled or has no active bodies.
   */
  evaluate(doc: SceneDoc, frame: number, host: RigidBodyHost): Map<string, Mat4> | null {
    void doc;
    void frame;
    void host;
    return null;
  }

  /** Drops the simulation cache. */
  reset(): void {}
}
