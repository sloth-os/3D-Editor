import type { SceneDoc } from '../doc/scene-doc';
import type { EvaluatedObject } from '../eval/evaluate';
import type { EvaluatedInstance } from './types';

export interface InstanceContext {
  doc: SceneDoc;
  frame: number;
  forRender: boolean;
  /** Evaluated objects (meshes, matrices, visibility) of the current evaluation. */
  objects: readonly EvaluatedObject[];
  byId: ReadonlyMap<string, EvaluatedObject>;
}

export interface InstanceResult {
  instances: EvaluatedInstance[];
  errors: { objectId: string; message: string }[];
}

/**
 * Expands collection instances (empties with instance_type COLLECTION) and particle systems
 * into instances. Instances of hidden source objects are still generated; visibility follows the
 * owner. Must be deterministic (seeded) and bounded (nesting depth, instance count).
 *
 * Phase-0 stub: no instances. The instancing workstream implements it.
 */
export function expandInstances(ctx: InstanceContext): InstanceResult {
  void ctx;
  return { instances: [], errors: [] };
}
