import {
  cloneMesh,
  evaluateModifierStack,
  getModifierDef,
  listModifierDefs,
  modifierObjectParams,
  newId,
  registerBuiltinModifiers,
  safeJsonSchema,
  uniqueName,
  defaultModifierParams,
  type ModifierData,
  type ObjectData,
  type ObjectType,
  type OperatorRegistry,
} from '@3d-editor/core';
import { ToolError, type AgentProject } from './agent';
import { evaluateCached } from './eval-cache';

/*
 * Modifier stack editing for MCP tools. The operators `object.modifier_add|set|remove|apply`
 * are used when registered (they are the single entry point for user actions); their parameter
 * names are matched against the operator's schema, and the outcome is verified against the
 * document. Missing operators fall back to equivalent direct document edits.
 *
 * Curve and text objects (CURVE, FONT) have modifier stacks too (applied to the geometry the curve
 * generates, like in Blender); the core modifier operators only accept meshes, so their stacks
 * are edited with direct document edits (one undo step, validated with the modifier schemas).
 * Object references in parameters (ARMATURE / CURVE `object`, BOOLEAN `object`, ARRAY
 * `offset_object`, …) may be given by name and are stored as object ids.
 */

/** Object types with a modifier stack. */
export const MODIFIER_OBJECT_TYPES: readonly ObjectType[] = ['MESH', 'CURVE', 'FONT'];

/** Whether the core modifier operators handle this object (they only accept meshes). */
function operatorsApply(o: ObjectData): boolean {
  return o.type === 'MESH';
}

/**
 * Resolves object references (by id or name) in a parameter patch of `type` to object ids
 * ('' or null clears them). Throws a ToolError for unknown objects or self references.
 */
export function resolveObjectParams(
  p: AgentProject,
  owner: ObjectData,
  type: string,
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!params) return params;
  const out = { ...params };
  for (const k of modifierObjectParams(type)) {
    const v = out[k];
    if (v === '' || v === null) {
      out[k] = null;
      continue;
    }
    if (typeof v !== 'string') continue;
    const ref = p.scene.resolveObject(v);
    if (!ref) throw new ToolError(`Object '${v}' (modifier parameter '${k}') not found.`);
    if (ref.id === owner.id)
      throw new ToolError(
        `Modifier parameter '${k}' cannot reference the modifier's own object '${owner.name}'.`,
      );
    out[k] = ref.id;
  }
  return out;
}

export type ModifierPatch = {
  name?: string;
  params?: Record<string, unknown>;
  show_viewport?: boolean;
  show_render?: boolean;
  show_in_editmode?: boolean;
};

export interface ModifierChange {
  modifier: ModifierData | null;
  /** How the change was made. */
  via: 'operator' | 'document' | 'operator+document';
}

const SETTINGS_KEYS = ['params', 'settings', 'values', 'properties'];
const REF_KEYS = ['modifier', 'modifier_id', 'modifier_name'];
const FLAG_KEYS = ['show_viewport', 'show_render', 'show_in_editmode'] as const;

export function modifierTypes(): { type: string; label: string; category: string; description: string }[] {
  registerBuiltinModifiers();
  return listModifierDefs()
    .map((d) => ({ type: d.type, label: d.label, category: d.category, description: d.description }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

/**
 * JSON schema of a modifier type's parameters (types, enums, ranges, defaults and descriptions;
 * without the `$schema` URL), or null for unknown types.
 */
export function modifierParamsSchema(type: string): Record<string, unknown> | null {
  registerBuiltinModifiers();
  const def = getModifierDef(type);
  if (!def) return null;
  const { $schema: _url, ...schema } = safeJsonSchema(def.schema) as Record<string, unknown>;
  return schema;
}

/** The modifier type of an identifier or label ('SUBSURF', 'subsurf', 'Subdivision Surface'), or null. */
export function findModifierType(type: string): string | null {
  registerBuiltinModifiers();
  const t = type.trim();
  const lower = t.toLowerCase();
  const def =
    getModifierDef(t) ??
    getModifierDef(t.toUpperCase()) ??
    listModifierDefs().find((d) => d.label.toLowerCase() === lower);
  return def?.type ?? null;
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** The known parameter closest to a misspelled one, or null. */
function closest(name: string, known: readonly string[]): string | null {
  const n = name.toLowerCase();
  let best: string | null = null;
  let score = Infinity;
  for (const k of known) {
    const d = k.includes(n) || n.includes(k) ? 1 : editDistance(n, k);
    if (d < score) {
      score = d;
      best = k;
    }
  }
  return best && score <= Math.max(2, Math.floor(n.length / 3)) ? best : null;
}

export function findModifier(o: ObjectData, ref: string): ModifierData | null {
  return (
    o.modifiers.find((m) => m.id === ref) ??
    o.modifiers.find((m) => m.name === ref) ??
    o.modifiers.find((m) => m.name.toLowerCase() === ref.toLowerCase()) ??
    null
  );
}

export function requireModifier(o: ObjectData, ref: string): ModifierData {
  const m = findModifier(o, ref);
  if (!m) {
    const names = o.modifiers.map((x) => `'${x.name}' (${x.type})`).join(', ');
    throw new ToolError(
      `Modifier '${ref}' not found on '${o.name}'.${names ? ` Its modifiers: ${names}.` : ' It has no modifiers.'}`,
    );
  }
  return m;
}

function operatorParamNames(registry: OperatorRegistry, id: string): Set<string> | null {
  const def = registry.get(id);
  if (!def) return null;
  const schema = safeJsonSchema(def.schema) as { properties?: Record<string, unknown> };
  return new Set(Object.keys(schema.properties ?? {}));
}

function selectOnly(p: AgentProject, objectId: string): void {
  p.state.mode = 'OBJECT';
  p.state.selectedIds = [objectId];
  p.state.activeId = objectId;
}

function buildParams(
  names: Set<string>,
  opts: { objectId: string; modifierRef?: string; type?: string; name?: string; patch?: ModifierPatch },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (names.has('object')) out.object = opts.objectId;
  else if (names.has('objects')) out.objects = [opts.objectId];
  if (opts.type !== undefined && names.has('type')) out.type = opts.type;
  let refKey: string | undefined;
  if (opts.modifierRef !== undefined) {
    refKey = REF_KEYS.find((k) => names.has(k)) ?? (names.has('name') ? 'name' : undefined);
    if (refKey) out[refKey] = opts.modifierRef;
  }
  const patch = opts.patch ?? {};
  const newName = opts.name ?? patch.name;
  if (newName !== undefined) {
    if (names.has('new_name')) out.new_name = newName;
    else if (refKey !== 'name' && names.has('name')) out.name = newName;
  }
  for (const k of FLAG_KEYS) if (patch[k] !== undefined && names.has(k)) out[k] = patch[k];
  if (patch.params && Object.keys(patch.params).length) {
    const settingsKey = SETTINGS_KEYS.find((k) => names.has(k));
    if (settingsKey) out[settingsKey] = patch.params;
    else for (const [k, v] of Object.entries(patch.params)) if (names.has(k) && !(k in out)) out[k] = v;
  }
  return out;
}

/**
 * Validates a parameter patch against the modifier type and returns the merged params. Unknown
 * parameter names and invalid values are rejected with the type's JSON schema (names, types,
 * enums, ranges, defaults), so the caller can correct the call.
 */
function mergeParams(mod: Pick<ModifierData, 'type' | 'params'>, params: Record<string, unknown> = {}) {
  registerBuiltinModifiers();
  const def = getModifierDef(mod.type);
  const merged = { ...mod.params, ...params };
  if (!def) return { params: merged };
  const known = Object.keys((def.schema as { shape?: Record<string, unknown> }).shape ?? {});
  const unknown = known.length ? Object.keys(params).filter((k) => !known.includes(k)) : [];
  const schema = () =>
    `${mod.type} parameters (JSON schema): ${JSON.stringify(modifierParamsSchema(mod.type))}`;
  if (unknown.length) {
    const hints = unknown
      .map((k) => [k, closest(k, known)] as const)
      .filter(([, c]) => c)
      .map(([k, c]) => `'${k}' → '${c}'?`);
    throw new ToolError(
      `Unknown parameter${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `'${k}'`).join(', ')} for the ${mod.type} modifier` +
        `${hints.length ? ` (did you mean ${hints.join(', ')})` : ''}. Valid parameters: ${known.join(', ')}. ${schema()}`,
    );
  }
  const res = def.schema.safeParse(merged);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ');
    throw new ToolError(`Invalid parameters for the ${mod.type} modifier: ${msg}. ${schema()}`);
  }
  return { params: res.data as Record<string, unknown> };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Applies a patch with direct document edits (fallback / completing operator results). */
function patchDirect(p: AgentProject, objectId: string, modId: string, patch: ModifierPatch): void {
  p.transact(() => {
    const o = p.scene.getObject(objectId);
    if (!o) throw new ToolError('object disappeared');
    const mods = o.modifiers.map((m) => {
      if (m.id !== modId) return m;
      const next: ModifierData = { ...m };
      if (patch.params) next.params = mergeParams(m, patch.params).params;
      for (const k of FLAG_KEYS) if (patch[k] !== undefined) next[k] = patch[k]!;
      if (patch.name !== undefined && patch.name !== m.name) {
        next.name = uniqueName(
          patch.name,
          o.modifiers.filter((x) => x.id !== m.id).map((x) => x.name),
        );
      }
      return next;
    });
    p.scene.updateObject(objectId, { modifiers: mods });
  });
}

/** Whether the modifier already reflects the patch. */
function satisfies(mod: ModifierData, patch: ModifierPatch): boolean {
  if (patch.name !== undefined && mod.name !== patch.name) return false;
  for (const k of FLAG_KEYS) if (patch[k] !== undefined && mod[k] !== patch[k]) return false;
  for (const [k, v] of Object.entries(patch.params ?? {})) if (!sameValue(mod.params[k], v)) return false;
  return true;
}

export function addModifier(
  p: AgentProject,
  registry: OperatorRegistry,
  object: ObjectData,
  type: string,
  opts: { name?: string; params?: Record<string, unknown> } = {},
): ModifierChange {
  registerBuiltinModifiers();
  const found = findModifierType(type);
  const def = found ? getModifierDef(found) : undefined;
  if (!def) {
    const types = modifierTypes()
      .map((t) => t.type)
      .join(', ');
    throw new ToolError(
      `Unknown modifier type '${type}'. Available types: ${types || '(none registered)'} (list_modifier_types describes them with their parameters).`,
    );
  }
  if (!MODIFIER_OBJECT_TYPES.includes(object.type))
    throw new ToolError(
      `Modifiers can only be added to mesh, curve and text objects ('${object.name}' is ${object.type}).`,
    );
  type = def.type;
  const params = resolveObjectParams(p, object, type, opts.params);
  if (params) mergeParams({ type, params: defaultModifierParams(type) }, params); // validate early
  opts = { ...opts, params };
  return p.step(() => {
    const before = new Set(object.modifiers.map((m) => m.id));
    const names = operatorsApply(object) ? operatorParamNames(registry, 'object.modifier_add') : null;
    let via: ModifierChange['via'] = 'document';
    let added: ModifierData | null = null;
    if (names) {
      selectOnly(p, object.id);
      const res = p.run(
        'object.modifier_add',
        buildParams(names, { objectId: object.id, type, name: opts.name, patch: { params: opts.params } }),
      );
      if (!res.ok) throw new ToolError(`object.modifier_add failed: ${res.error}`);
      added =
        p.scene.getObject(object.id)?.modifiers.find((m) => !before.has(m.id) && m.type === type) ?? null;
      if (added) via = 'operator';
    }
    if (!added) {
      const o = p.scene.getObject(object.id)!;
      const mod: ModifierData = {
        id: newId(),
        name: uniqueName(
          opts.name ?? def.label,
          o.modifiers.map((m) => m.name),
        ),
        type,
        show_viewport: true,
        show_render: true,
        show_in_editmode: true,
        show_expanded: true,
        params: defaultModifierParams(type),
      };
      p.transact(() => p.scene.updateObject(o.id, { modifiers: [...o.modifiers, mod] }));
      added = mod;
    }
    const patch: ModifierPatch = { name: opts.name, params: opts.params };
    if (!satisfies(added, patch)) {
      patchDirect(p, object.id, added.id, patch);
      if (via === 'operator') via = 'operator+document';
    }
    const final = p.scene.getObject(object.id)?.modifiers.find((m) => m.id === added!.id) ?? added;
    return { modifier: final, via };
  });
}

export function updateModifier(
  p: AgentProject,
  registry: OperatorRegistry,
  object: ObjectData,
  mod: ModifierData,
  patch: ModifierPatch,
): ModifierChange {
  patch = { ...patch, params: resolveObjectParams(p, object, mod.type, patch.params) };
  if (patch.params) mergeParams(mod, patch.params); // validate early
  return p.step(() => {
    const names = operatorsApply(object) ? operatorParamNames(registry, 'object.modifier_set') : null;
    let via: ModifierChange['via'] = 'document';
    if (names) {
      selectOnly(p, object.id);
      const res = p.run(
        'object.modifier_set',
        buildParams(names, { objectId: object.id, modifierRef: mod.name, patch }),
      );
      if (!res.ok) throw new ToolError(`object.modifier_set failed: ${res.error}`);
      via = 'operator';
    }
    let current = p.scene.getObject(object.id)?.modifiers.find((m) => m.id === mod.id) ?? null;
    if (!current) throw new ToolError(`Modifier '${mod.name}' disappeared while updating it.`);
    if (!satisfies(current, patch)) {
      patchDirect(p, object.id, mod.id, patch);
      via = via === 'operator' ? 'operator+document' : 'document';
      current = p.scene.getObject(object.id)?.modifiers.find((m) => m.id === mod.id) ?? current;
    }
    return { modifier: current, via };
  });
}

export function removeModifier(
  p: AgentProject,
  registry: OperatorRegistry,
  object: ObjectData,
  mod: ModifierData,
): ModifierChange {
  return p.step(() => {
    const names = operatorsApply(object) ? operatorParamNames(registry, 'object.modifier_remove') : null;
    let via: ModifierChange['via'] = 'document';
    const stillThere = () => !!p.scene.getObject(object.id)?.modifiers.some((m) => m.id === mod.id);
    if (names) {
      selectOnly(p, object.id);
      const res = p.run(
        'object.modifier_remove',
        buildParams(names, { objectId: object.id, modifierRef: mod.name }),
      );
      if (!res.ok) throw new ToolError(`object.modifier_remove failed: ${res.error}`);
      via = 'operator';
    }
    if (stillThere()) {
      p.transact(() => {
        const o = p.scene.getObject(object.id)!;
        p.scene.updateObject(o.id, { modifiers: o.modifiers.filter((m) => m.id !== mod.id) });
      });
      via = via === 'operator' ? 'operator+document' : 'document';
    }
    return { modifier: mod, via };
  });
}

/** Bakes one modifier into the mesh (Blender "Apply") without operators. */
function applyDirect(p: AgentProject, object: ObjectData, mod: ModifierData): void {
  if (!object.data) throw new ToolError(`'${object.name}' has no mesh data`);
  const base = p.scene.getMesh(object.data);
  if (!base) throw new ToolError(`'${object.name}' has no mesh data`);
  // Apply uses the viewport settings of the stack, like Blender
  const ev = evaluateCached(p.scene, p.state.frame, 'VIEWPORT');
  const res = evaluateModifierStack(base, [{ ...mod, show_viewport: true }], {
    frame: p.state.frame,
    objectMatrix: ev.byId.get(object.id)?.worldMatrix ?? p.scene.worldMatrix(object.id),
    getObjectMesh: (id) => {
      const e = ev.byId.get(id);
      return e?.mesh && id !== object.id ? { mesh: e.mesh, matrix: e.worldMatrix } : null;
    },
    getObjectMatrix: (id) => ev.byId.get(id)?.worldMatrix ?? null,
    // Armature modifier: the evaluated pose and the mesh's vertex groups
    getArmature: (id) => {
      const e = ev.byId.get(id);
      return e?.pose ? { pose: e.pose, matrix: e.worldMatrix } : null;
    },
    vertexGroups: p.scene.getVertexGroups(object.data),
    forRender: false,
    editMode: false,
  });
  if (res.errors.length)
    throw new ToolError(`Applying '${mod.name}' failed: ${res.errors.map((e) => e.message).join('; ')}`);
  p.transact(() => {
    const o = p.scene.getObject(object.id)!;
    let meshId = o.data!;
    if (p.scene.dataUsers(meshId) > 1) {
      meshId = p.scene.addMesh(p.scene.getMeshBlock(meshId)?.name ?? o.name, cloneMesh(res.mesh));
      p.scene.updateObject(o.id, { data: meshId });
    } else p.scene.setMesh(meshId, cloneMesh(res.mesh));
    p.scene.updateObject(o.id, { modifiers: o.modifiers.filter((m) => m.id !== mod.id) });
  });
}

export function applyModifier(
  p: AgentProject,
  registry: OperatorRegistry,
  object: ObjectData,
  mod: ModifierData,
): ModifierChange {
  if (!operatorsApply(object))
    throw new ToolError(
      `Modifiers of ${object.type === 'FONT' ? 'text' : 'curve'} objects cannot be applied one by one; convert the object to a mesh instead, ` +
        `which bakes its geometry with every modifier: run_operator {"operator": "object.convert", "params": {"target": "MESH"}, ` +
        `"selection": {"objects": [${JSON.stringify(object.name)}]}} (object.convert converts the selected objects).`,
    );
  return p.step(() => {
    const names = operatorParamNames(registry, 'object.modifier_apply');
    if (names) {
      selectOnly(p, object.id);
      const res = p.run(
        'object.modifier_apply',
        buildParams(names, { objectId: object.id, modifierRef: mod.name }),
      );
      if (!res.ok) throw new ToolError(`object.modifier_apply failed: ${res.error}`);
      if (!p.scene.getObject(object.id)?.modifiers.some((m) => m.id === mod.id))
        return { modifier: mod, via: 'operator' };
    }
    applyDirect(p, p.scene.getObject(object.id) ?? object, mod);
    return { modifier: mod, via: names ? 'operator+document' : 'document' };
  });
}
