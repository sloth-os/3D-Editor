import type { Mat4 } from '../math/types';
import type { MeshData } from '../mesh/types';
import type { ModifierData, ObjectData } from '../doc/types';
import type { SceneDoc } from '../doc/scene-doc';
import type { EvaluatedObject, EvaluatedScene } from '../eval/evaluate';
import { identity4 } from '../math/mat4';
import {
  evaluateModifierStack,
  getModifierDef,
  isModifierEnabled,
  isModifierTimeDependent,
  modifierDependencies,
  registerBuiltinModifiers,
  type ModifierContext,
} from '../modifiers';
import { stableStringify } from '../util/json';

/*
 * Undeformed ("orco", Blender's original coordinates) positions for GENERATED texture coordinates.
 *
 * Blender computes Generated coordinates from the undeformed mesh so that textures stick to the
 * surface when it deforms: shape keys and deform modifiers (Armature, Curve, Simple Deform, Cast,
 * Wave, Displace, Shrinkwrap, Smooth) do not move them, while the other modifiers (Subdivision,
 * Mirror, Array, Solidify, Bevel, …) are applied to them as well. When that generate-only result
 * does not match the evaluated topology (e.g. a merge by distance that depends on the deformed
 * positions), the evaluated positions are used, like Blender does.
 */

/** Dependency access for generate modifiers that read other objects (Boolean, offset objects). */
export interface OrcoDependencies {
  getObjectMesh: ModifierContext['getObjectMesh'];
  getObjectMatrix?: ModifierContext['getObjectMatrix'];
  getArmature?: ModifierContext['getArmature'];
  /** The types of objects, which disable some modifiers as in the evaluation (ModifierContext). */
  getObjectType?: ModifierContext['getObjectType'];
  /** Cache signature of everything the modifiers may read from object `id`, its type included. */
  signature(id: string): string;
}

/** Inputs of `orcoMesh`. */
export interface OrcoInput {
  /** The object: type and (animated) modifier stack. */
  object: Pick<ObjectData, 'type' | 'modifiers'>;
  /** Base (pre-shape-key, pre-modifier) mesh. */
  base: MeshData;
  /** The mesh has shape keys (which deform it). */
  hasShapeKeys: boolean;
  /** Evaluation mode of the evaluated mesh (modifier show_render / show_viewport / show_in_editmode). */
  forRender: boolean;
  editMode?: boolean;
  /** Frame (time-dependent generate modifiers). */
  frame?: number;
  /** World matrix of the object (generate modifiers reading other objects). */
  objectMatrix?: Mat4;
  /** Other objects; without it, stacks whose generate modifiers read other objects give null. */
  deps?: OrcoDependencies;
}

/** Last results per base mesh (a few entries: viewport and render evaluations of one mesh). */
const cache = new WeakMap<MeshData, { key: string; mesh: MeshData | null }[]>();
const CACHE_ENTRIES = 4;

/**
 * Mesh whose vertex positions are the orco (undeformed positions) of an object's evaluated mesh,
 * with the same topology as the evaluated mesh when nothing depends on the deformation; null when
 * nothing deforms the object (the evaluated positions are the orco) or when the orco cannot be
 * computed (generate modifiers reading other objects without `deps`). Callers must check that the
 * vertex count matches the evaluated mesh. Pure (results are cached per base mesh and content key).
 */
export function orcoMesh(input: OrcoInput): MeshData | null {
  registerBuiltinModifiers();
  const flags = { forRender: input.forRender, editMode: !!input.editMode };
  const active = (input.object.modifiers ?? []).filter((m) => isModifierEnabled(m, flags));
  let deforms = input.hasShapeKeys && input.object.type === 'MESH';
  const generate: ModifierData[] = [];
  for (const m of active) {
    if (getModifierDef(m.type)?.category === 'DEFORM') deforms = true;
    else generate.push(m);
  }
  if (!deforms) return null;
  if (!generate.length) return input.base;
  const deps: string[] = [];
  let timeDependent = false;
  for (const m of generate) {
    deps.push(...modifierDependencies(m));
    if (isModifierTimeDependent(m)) timeDependent = true;
  }
  if (deps.length && !input.deps) return null;
  const key = [
    stableStringify(generate),
    input.forRender ? 'R' : 'V',
    input.editMode ? 'E' : '',
    timeDependent ? `f${input.frame ?? 0}` : '',
    deps.length ? (input.objectMatrix ?? identity4()).join(',') : '',
    deps.map((d) => input.deps!.signature(d)).join('|'),
  ].join('#');
  let entries = cache.get(input.base);
  const hit = entries?.find((e) => e.key === key);
  if (hit) return hit.mesh;
  let mesh: MeshData | null;
  const getObjectType = input.deps?.getObjectType;
  try {
    mesh = evaluateModifierStack(input.base, generate, {
      frame: input.frame ?? 0,
      objectMatrix: input.objectMatrix ?? identity4(),
      forRender: input.forRender,
      editMode: !!input.editMode,
      getObjectMesh: (id) => input.deps?.getObjectMesh(id) ?? null,
      getObjectMatrix: (id) => input.deps?.getObjectMatrix?.(id) ?? null,
      getArmature: (id) => input.deps?.getArmature?.(id) ?? null,
      ...(getObjectType ? { getObjectType: (id: string) => getObjectType(id) } : {}),
    }).mesh;
  } catch {
    mesh = null;
  }
  if (!entries) cache.set(input.base, (entries = []));
  entries.unshift({ key, mesh });
  if (entries.length > CACHE_ENTRIES) entries.length = CACHE_ENTRIES;
  return mesh;
}

/** Dependency access to the objects of an evaluated scene (for `orcoMesh`). */
export function sceneOrcoDependencies(scene: EvaluatedScene): OrcoDependencies {
  return {
    getObjectMesh: (id) => {
      const o = scene.byId.get(id);
      return o?.mesh ? { mesh: o.mesh, matrix: o.worldMatrix } : null;
    },
    getObjectMatrix: (id) => scene.byId.get(id)?.worldMatrix ?? null,
    getArmature: (id) => {
      const o = scene.byId.get(id);
      return o?.pose ? { pose: o.pose, matrix: o.worldMatrix } : null;
    },
    getObjectType: (id) => scene.byId.get(id)?.type ?? null,
    signature: (id) => {
      const o = scene.byId.get(id);
      return o ? `${id}:${o.type}:${o.meshKey ?? ''}:${o.worldMatrix.join(',')}` : `${id}:missing`;
    },
  };
}

/**
 * Orco of an evaluated object's mesh: the undeformed position of every vertex of `ev.mesh`
 * (xyz per vertex, object space), or null when they equal the evaluated positions (nothing
 * deforms the object) or cannot be matched to them (different topology). `forRender` must match
 * the evaluation that produced `ev.mesh`.
 */
export function evaluatedOrco(
  doc: Pick<SceneDoc, 'meshAttrVersion'>,
  scene: EvaluatedScene | null,
  ev: EvaluatedObject,
  forRender: boolean,
): number[] | null {
  const mesh = ev.mesh;
  const base = ev.baseMesh;
  if (!mesh || !base) return null;
  const orco = orcoMesh({
    object: ev.data,
    base,
    hasShapeKeys:
      ev.type === 'MESH' && !!ev.data.data && doc.meshAttrVersion(ev.data.data, 'shape_keys') !== 0,
    forRender,
    frame: scene?.frame,
    objectMatrix: ev.worldMatrix,
    deps: scene ? sceneOrcoDependencies(scene) : undefined,
  });
  if (!orco || orco === mesh || orco.positions.length !== mesh.positions.length) return null;
  return orco.positions;
}
