import { ANIMATABLE, type AnimTargetType, type Interpolation } from '@3d-editor/core';
import { ToolError, type AgentProject } from './agent';

/*
 * Resolution of `insert_keyframe` property paths to animation targets: object properties and
 * nested object paths (pose bones, constraints, modifiers, particle systems), the object's data
 * (`data.` light / camera / curve / mesh shape keys), its materials (`material.`) and the world.
 */

export interface KeyframeTarget {
  type: AnimTargetType;
  /** Datablock id of the target ('world' for the world). */
  id: string;
  /** Object the property belongs to (or whose data it is). */
  objectId?: string;
  /** Datablock name (for messages and results). */
  name: string;
  /** "object 'Cube'", "curve data of 'Path'", … */
  label: string;
  /** Property path on the target. */
  path: string;
}

/** Nested path patterns per target type, as shown in error messages. */
const NESTED_PATHS: Partial<Record<AnimTargetType, string[]>> = {
  object: [
    'pose.bones["Bone"].location|rotation_euler|scale',
    'pose.bones["Bone"].constraints["Name"].influence',
    'constraints["Name"].influence (or a numeric constraint parameter)',
    'modifiers["Name"].<parameter>',
    'particle_systems["Name"].<setting>',
  ],
  mesh: ['shape_keys["Key"].value'],
  curve: ['splines[i].points[j].co|handle_left|handle_right|radius|tilt|weight'],
  material: ['textures.<channel>.procedural.<parameter>'],
};

/** Error message for a property that cannot be keyed, listing what can. */
export function notAnimatable(t: KeyframeTarget): string {
  const flat = Object.keys(ANIMATABLE[t.type] ?? {});
  const nested = NESTED_PATHS[t.type] ?? [];
  const all = [...flat, ...nested].join(', ') || 'nothing';
  return (
    `'${t.path}' is not animatable on ${t.type}. Animatable: ${all}. ` +
    "Prefix 'data.' for the object's light/camera/curve/mesh data and 'material.' for its material; " +
    'custom properties can be driven with anim.driver_add.'
  );
}

/** Resolves the target of an insert_keyframe call. */
export function keyframeTarget(
  p: AgentProject,
  objectRef: string,
  property: string,
  materialSlot?: number,
): KeyframeTarget {
  if (objectRef === 'world')
    return { type: 'world', id: 'world', name: 'World', label: 'the world', path: property };
  const o = p.scene.resolveObject(objectRef);
  if (!o) throw new ToolError(`Object '${objectRef}' not found.`);
  if (property.startsWith('data.')) {
    const path = property.slice(5);
    const type: AnimTargetType | null =
      o.type === 'LIGHT'
        ? 'light'
        : o.type === 'CAMERA'
          ? 'camera'
          : o.type === 'CURVE' || o.type === 'FONT'
            ? 'curve'
            : o.type === 'MESH'
              ? 'mesh'
              : null;
    if (!type || !o.data)
      throw new ToolError(
        o.type === 'ARMATURE'
          ? `Armature data is not animated; key pose bones instead, e.g. property 'pose.bones["Bone"].rotation_euler'.`
          : `'${o.name}' (${o.type}) has no animatable data.`,
      );
    return {
      type,
      id: o.data,
      objectId: o.id,
      name: o.name,
      label: `the ${type} data of '${o.name}'`,
      path,
    };
  }
  if (property.startsWith('material.')) {
    const slots = o.material_slots;
    const id = materialSlot !== undefined ? slots[materialSlot] : slots.find(Boolean);
    if (!id)
      throw new ToolError(
        materialSlot !== undefined
          ? `'${o.name}' has no material in slot ${materialSlot}.`
          : `'${o.name}' has no material.`,
      );
    const m = p.scene.getMaterial(id);
    return {
      type: 'material',
      id,
      objectId: o.id,
      name: m?.name ?? id,
      label: `material '${m?.name ?? id}'`,
      path: property.slice(9),
    };
  }
  if (property.startsWith('shape_keys[') && o.type === 'MESH' && o.data)
    return {
      type: 'mesh',
      id: o.data,
      objectId: o.id,
      name: o.name,
      label: `the mesh data of '${o.name}'`,
      path: property,
    };
  return {
    type: 'object',
    id: o.id,
    objectId: o.id,
    name: o.name,
    label: `object '${o.name}'`,
    path: property,
  };
}

/** The stored datablock of a target (what animation paths are read from), or null. */
export function keyTargetData(
  p: AgentProject,
  type: AnimTargetType,
  id: string,
): Record<string, unknown> | null {
  const d = p.scene;
  const rec = (v: unknown) => (v ? (v as Record<string, unknown>) : null);
  switch (type) {
    case 'object':
      return rec(d.getObject(id));
    case 'material':
      return rec(d.getMaterial(id));
    case 'light':
      return rec(d.getLight(id));
    case 'camera':
      return rec(d.getCamera(id));
    case 'world':
      return rec(d.getWorld());
    case 'scene':
      return rec(d.getScene());
    case 'mesh':
      return d.getMeshBlock(id) ? { shape_keys: d.getShapeKeys(id) } : null;
    case 'curve':
      return rec(d.getCurve(id));
  }
}

/** Interpolation values accepted by the keyframe operators. */
export type KeyInterpolation = Interpolation;
