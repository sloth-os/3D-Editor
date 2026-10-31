import type { Mat4 } from '../math/types';
import type { MeshData } from '../mesh/types';
import type { MaterialData, ObjectData } from '../doc/types';
import type { EvaluatedObject, EvaluatedScene } from './evaluate';

/** A piece of geometry to draw/export: an object with a mesh, or an instance of one. */
export interface RenderItem {
  /** Object id, or instance id for instances. */
  id: string;
  /** Object providing the geometry and materials (the instanced object for instances). */
  object: EvaluatedObject;
  /** Object data of `object` (display color, flags). */
  data: ObjectData;
  /** Object whose visibility/selection this item follows (the instancer for instances). */
  ownerId: string;
  mesh: MeshData;
  meshKey: string;
  worldMatrix: Mat4;
  materials: (MaterialData | null)[];
  instance: boolean;
}

/**
 * Every visible piece of geometry of an evaluated scene: objects with an evaluated mesh (meshes,
 * curves, text) plus collection/particle instances. Instances follow their owner's visibility
 * (their source objects may be hidden, which is the usual setup).
 */
export function renderItems(ev: EvaluatedScene, opts: { forRender?: boolean } = {}): RenderItem[] {
  const vis = (o: EvaluatedObject) => (opts.forRender ? o.renderVisible : o.visible);
  const out: RenderItem[] = [];
  for (const o of ev.objects) {
    if (!o.mesh || !vis(o)) continue;
    out.push({
      id: o.id,
      object: o,
      data: o.data,
      ownerId: o.id,
      mesh: o.mesh,
      meshKey: o.meshKey ?? '',
      worldMatrix: o.worldMatrix,
      materials: o.materials,
      instance: false,
    });
  }
  for (const inst of ev.instances) {
    const owner = ev.byId.get(inst.ownerId);
    const src = ev.byId.get(inst.sourceId);
    if (!owner || !src?.mesh || !vis(owner)) continue;
    out.push({
      id: inst.id,
      object: src,
      data: src.data,
      ownerId: inst.ownerId,
      mesh: src.mesh,
      meshKey: src.meshKey ?? '',
      worldMatrix: inst.matrix,
      materials: src.materials,
      instance: true,
    });
  }
  return out;
}
