import type { Mat4 } from '../math/types';
import { compose4, decompose4, equals4 } from '../math/mat4';
import type { ObjectData } from '../doc/types';
import type { EvaluatedObject, EvaluatedScene } from '../eval/evaluate';
import type { ExportItem } from '../io/common';
import { invertAffine, isFiniteMatrix, mulAffine } from './matrix';

/*
 * Instances as export items: every instance becomes a pseudo object that shares the source's
 * evaluated mesh and materials. Exporters that bake world-space geometry (OBJ, STL, PLY) write it
 * like any other object; the glTF exporter turns it into a node referencing the source's mesh
 * (meshes are shared by identity), parented to its owner node when the owner is exported and the
 * relative transform is a clean TRS (otherwise a root node with the world transform).
 */

/** Relative transform when it can be represented as location/rotation/scale (no shear). */
function cleanTrs(m: Mat4): ReturnType<typeof decompose4> | null {
  if (!isFiniteMatrix(m)) return null;
  const d = decompose4(m);
  const back = compose4(d.location, d.rotation, d.scale);
  const scale = Math.max(Math.abs(d.scale[0]), Math.abs(d.scale[1]), Math.abs(d.scale[2]), 1e-12);
  return equals4(back, m, 1e-6 * Math.max(1, scale)) ? d : null;
}

/**
 * Export items for the instances owned by the exported objects (`ownerIds`). Instance names are
 * `<owner>.<source>.<n>` (n counts per owner, starting at 1). With `applyModifiers` false the
 * source's base mesh is used.
 */
export function instanceExportItems(
  scene: EvaluatedScene,
  ownerIds: ReadonlySet<string>,
  applyModifiers = true,
): ExportItem[] {
  const out: ExportItem[] = [];
  const counters = new Map<string, number>();
  const inverses = new Map<string, Mat4 | null>();
  for (const inst of scene.instances) {
    if (!ownerIds.has(inst.ownerId)) continue;
    const src = scene.byId.get(inst.sourceId);
    const owner = scene.byId.get(inst.ownerId);
    if (!src || !owner || !isFiniteMatrix(inst.matrix)) continue;
    const mesh = applyModifiers ? src.mesh : (src.baseMesh ?? src.mesh);
    if (!mesh) continue;
    const n = (counters.get(owner.id) ?? 0) + 1;
    counters.set(owner.id, n);
    const name = `${owner.name}.${src.name}.${String(n).padStart(3, '0')}`;
    if (!inverses.has(owner.id)) inverses.set(owner.id, invertAffine(owner.worldMatrix));
    const inv = inverses.get(owner.id)!;
    const local = inv ? mulAffine(inv, inst.matrix) : null;
    let parent: string | null = null;
    let trs = local ? cleanTrs(local) : null;
    let localMatrix: Mat4 = inst.matrix;
    if (trs && local) {
      parent = owner.id;
      localMatrix = local;
    } else trs = decompose4(inst.matrix);
    const data: ObjectData = {
      ...src.data,
      id: inst.id,
      name,
      parent,
      parent_type: 'OBJECT',
      parent_bone: '',
      location: trs.location,
      rotation_euler: trs.rotation,
      scale: trs.scale,
      constraints: [],
      particle_systems: [],
      instance_type: 'NONE',
      instance_collection: null,
      hide_viewport: false,
      hide_render: false,
      custom_props: {},
      rigid_body: null,
    };
    const ev: EvaluatedObject = {
      ...src,
      id: inst.id,
      name,
      data,
      localMatrix,
      worldMatrix: inst.matrix,
      visible: owner.visible,
      renderVisible: owner.renderVisible,
      constraintErrors: [],
      simulated: false,
    };
    out.push({ ev, mesh, materials: src.materials, instance: { ownerId: owner.id, sourceId: src.id } });
  }
  return out;
}
