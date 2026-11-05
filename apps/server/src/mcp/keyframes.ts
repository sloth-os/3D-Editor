import {
  ANIMATABLE,
  getPathValue,
  parseDataPath,
  proceduralParamSpec,
  type AnimTargetType,
  type PathSegment,
  type ProceduralType,
} from '@3d-editor/core';
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

/** `segs` written as a data path (`constraints["Track To"].influence`, `splines[0]` …). */
function formatPath(segs: readonly PathSegment[]): string {
  let out = '';
  for (const seg of segs) {
    if (seg.kind === 'prop') out += out ? `.${seg.name}` : seg.name;
    else if (seg.kind === 'key') out += `[${JSON.stringify(seg.key)}]`;
    else out += `[${seg.index}]`;
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);

/** A value insert_keyframe can key: a number, a boolean or a vector of numbers. */
function keyable(v: unknown): boolean {
  return (
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number'))
  );
}

/** Keyable properties of a record and of its `params` / `settings` bag (for messages). */
function keyableNames(rec: Record<string, unknown>): string[] {
  const names = Object.keys(rec).filter((k) => keyable(rec[k]));
  for (const bag of ['params', 'settings']) {
    const b = rec[bag];
    if (isRecord(b)) names.push(...Object.keys(b).filter((k) => keyable(b[k])));
  }
  return [...new Set(names)];
}

function listNames(names: string[], max = 24): string {
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown}, … (${names.length} in all)` : shown;
}

/**
 * Why `path` does not lead to a keyable value of `root` (a datablock as stored), or null when it
 * does. The message names the first part of the path that does not exist and what exists there,
 * e.g. `constraints has no "Nope" (it has: "Track To")`.
 */
export function missingPathReason(root: Record<string, unknown>, path: string): string | null {
  let segs: PathSegment[];
  try {
    segs = parseDataPath(path);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  let container: unknown = root;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const value = getPathValue(root, formatPath(segs.slice(0, i + 1)));
    if (value === undefined) {
      const where = i ? formatPath(segs.slice(0, i)) : 'it';
      if (seg.kind === 'index') {
        const n = Array.isArray(container) ? container.length : 0;
        return Array.isArray(container)
          ? `${where} has ${n} item${n === 1 ? '' : 's'}, there is no index ${seg.index}`
          : `${where} is not a list`;
      }
      if (seg.kind === 'key') {
        const names = Array.isArray(container)
          ? container.map((e) => (isRecord(e) && typeof e.name === 'string' ? JSON.stringify(e.name) : null))
          : isRecord(container)
            ? Object.keys(container).map((k) => JSON.stringify(k))
            : [];
        const known = names.filter((n): n is string => !!n);
        return `${where} has no ${JSON.stringify(seg.key)} (${known.length ? `it has: ${listNames(known)}` : 'it is empty'})`;
      }
      if (!isRecord(container)) return `${where} has no property '${seg.name}'`;
      const names = keyableNames(container);
      return `${where} has no property '${seg.name}'${names.length ? ` (keyable there: ${listNames(names)})` : ''}`;
    }
    container = value;
  }
  return keyable(container) ? null : `'${path}' is not a number, boolean or vector`;
}

/**
 * A material path to a procedural texture parameter that is valid for the texture's type but not
 * stored yet (type-specific params are only stored once set): `{ channel, key, default }`, so the
 * caller can store the default before keying it. Null otherwise.
 */
export function unsetProceduralParam(
  material: Record<string, unknown>,
  path: string,
): { channel: string; key: string; value: number } | null {
  const m = /^textures\.(\w+)\.procedural\.(\w+)$/.exec(path);
  if (!m) return null;
  const tex = getPathValue(material, `textures.${m[1]}.procedural`);
  if (!isRecord(tex) || typeof tex.type !== 'string' || getPathValue(tex, m[2]) !== undefined) return null;
  const spec = proceduralParamSpec(tex.type as ProceduralType, m[2]);
  if (!spec || spec.kind === 'enum' || typeof spec.default !== 'number') return null;
  return { channel: m[1], key: m[2], value: spec.default };
}
