import type { z } from 'zod';
import type { Mat4 } from '../math/types';
import type { MeshData } from '../mesh/types';
import type { ModifierData, ObjectType, VertexGroupData } from '../doc/types';
import type { ArmaturePose } from '../armature/types';
import type { CurvePath } from '../curve/path';

/** Context available to modifiers during stack evaluation. */
export interface ModifierContext {
  /** Current (possibly fractional) frame. */
  frame: number;
  /** World matrix of the object owning the modifier stack. */
  objectMatrix: Mat4;
  /**
   * Evaluated mesh + world matrix of another object (e.g. the Boolean operand).
   * Returns null if the object does not exist, is not a mesh or would create a cycle.
   */
  getObjectMesh(id: string): { mesh: MeshData; matrix: Mat4 } | null;
  /**
   * Optional: world matrix of any object (including empties), e.g. a Mirror/Array/Cast helper object.
   * Modifiers fall back to `getObjectMesh(id).matrix` when the evaluator does not provide it.
   */
  getObjectMatrix?(id: string): Mat4 | null;
  /** True when evaluating for final render (uses `show_render` instead of `show_viewport`). */
  forRender: boolean;
  /** True when the owning object is in edit mode. */
  editMode: boolean;
  /** Optional: evaluated pose and world matrix of an armature object (Armature modifier). */
  getArmature?(id: string): { pose: ArmaturePose; matrix: Mat4 } | null;
  /** Optional: path (curve object space) and world matrix of a curve object (Curve modifier). */
  getCurvePath?(id: string): { path: CurvePath; matrix: Mat4 } | null;
  /**
   * Optional: the type of any object ('MESH', 'CURVE', 'FONT', 'ARMATURE', …), null when it does
   * not exist, for Blender's rules on which modifiers are disabled (ModifierDef.disabled). Without
   * it only what the other accessors make certain is known (an object with an armature pose is
   * an armature, one with a curve path a curve), and an object's type that is not known disables
   * no modifier.
   */
  getObjectType?(id: string): string | null;
  /** Vertex groups of the owner's mesh; only meaningful while the vertex count is unchanged. */
  vertexGroups?: readonly VertexGroupData[];
}

/**
 * What Blender's is_disabled of a modifier type reads (ModifierDef.disabled): the evaluation mode
 * and the types of the objects the modifier's parameters name.
 */
export interface ModifierDisabledContext {
  /** Final render settings (`render_levels`, …) instead of the viewport's. */
  forRender: boolean;
  /**
   * The type of object `id` ('MESH', 'CURVE', 'ARMATURE', …), null when no such object exists (a
   * parameter naming a deleted object, which Blender clears), undefined when it is not known (a
   * modifier is then not disabled for it).
   */
  objectType(id: string): string | null | undefined;
  /** The name of object `id` for the reasons given (default: the id). */
  objectName?(id: string): string;
}

export type ModifierCategory = 'GENERATE' | 'DEFORM' | 'NORMALS' | 'EDIT';

/**
 * A modifier type. `schema` validates and fills in defaults for the stored `params`
 * (`schema.parse({})` must succeed and yield the defaults). Parameter names follow Blender.
 */
export interface ModifierDef<S extends z.ZodObject<any> = z.ZodObject<any>> {
  /** Blender type identifier, e.g. 'SUBSURF'. */
  type: string;
  /** Human readable label, e.g. 'Subdivision Surface'. */
  label: string;
  category: ModifierCategory;
  description: string;
  schema: S;
  /** Whether the result depends on the current frame. */
  timeDependent?: boolean | ((params: z.infer<S>) => boolean);
  /** Object ids this modifier reads (e.g. Boolean operand, Mirror object). */
  dependencies?: (params: z.infer<S>) => string[];
  /**
   * Blender's is_disabled of the type (MOD_*.cc; types without one are never disabled): why the
   * modifier can do nothing with its parameters (no object of the type it needs, a factor of 0,
   * …), as a clause completing "the <label> modifier '<name>' …" (e.g. "has no object"), or null.
   * A disabled modifier is left out of the stack's evaluation without an error, as Blender's
   * BKE_modifier_is_enabled leaves it out, and Apply refuses it (object.modifier_apply).
   */
  disabled?: (params: z.infer<S>, ctx: ModifierDisabledContext) => string | null;
  /**
   * The object types the parameters that name an object accept, by parameter (e.g. `{ object:
   * ['MESH'] }` for the Boolean), as Blender's RNA setters accept them (rna_modifier.cc
   * RNA_MOD_OBJECT_SET: `modifier_object_set` stores no object of another type); a parameter not
   * listed accepts an object of any type. object.modifier_add and object.modifier_set refuse
   * another type (modifierObjectRefusal).
   */
  objectTypes?: { readonly [K in keyof z.infer<S>]?: readonly ObjectType[] };
  /** Pure function: must not mutate `mesh`. */
  apply(mesh: MeshData, params: z.infer<S>, ctx: ModifierContext): MeshData;
}

/** The object types parameter `param` of a `type` modifier accepts (ModifierDef.objectTypes); null: any. */
export function modifierObjectTypes(type: string, param: string): readonly ObjectType[] | null {
  const types = registry.get(type)?.objectTypes as Record<string, readonly ObjectType[]> | undefined;
  return types?.[param] ?? null;
}

const OBJECT_KINDS: Record<string, string> = {
  MESH: 'a mesh',
  CURVE: 'a curve',
  FONT: 'a text',
  ARMATURE: 'an armature',
  EMPTY: 'an empty',
  CAMERA: 'a camera',
  LIGHT: 'a light',
};
const objectKind = (type: string) => OBJECT_KINDS[type] ?? `a ${type.toLowerCase()}`;

/**
 * Why `object` cannot be stored in parameter `param` of a `type` modifier, or null: the parameter
 * takes objects of other types (ModifierDef.objectTypes), as in Blender, whose setter does not
 * store it. The message names what object.convert could make of the object where it can.
 */
export function modifierObjectRefusal(
  type: string,
  param: string,
  object: { name: string; type: string },
): string | null {
  const types = modifierObjectTypes(type, param);
  if (!types || (types as readonly string[]).includes(object.type)) return null;
  const label = registry.get(type)?.label ?? type;
  // object.convert makes meshes of curve and text objects, and curves of text objects
  const target =
    types.includes('MESH') && (object.type === 'CURVE' || object.type === 'FONT')
      ? 'MESH'
      : types.includes('CURVE') && object.type === 'FONT'
        ? 'CURVE'
        : null;
  return (
    `Parameter '${param}' of the ${label} modifier takes ${types.map(objectKind).join(' or ')} object; ` +
    `'${object.name}' is ${objectKind(object.type)} object` +
    (target ? ` (object.convert with target ${target} makes it one)` : '')
  );
}

/**
 * Why a parameter of a modifier that names an object does not name an object of one of `types`
 * (Blender's is_disabled checks of object pointers), or null: "has no <what>" without one (also
 * when it names a deleted object), else "has a <what>, '<name>', that is not <kind>". Not
 * `required` (an optional object, e.g. an Array cap), only an object of another type disables it;
 * an object whose type is not known (see ModifierDisabledContext.objectType) never does.
 */
export function disabledObjectParam(
  ctx: ModifierDisabledContext,
  id: string | null | undefined,
  types: readonly string[],
  what: string,
  kind: string,
  required = true,
): string | null {
  const type = id ? ctx.objectType(id) : null;
  if (type === undefined) return null;
  if (!id || type === null) return required ? `has no ${what}` : null;
  if (types.includes(type)) return null;
  const article = /^[aeiou]/i.test(what) ? 'an' : 'a';
  return `has ${article} ${what}, '${ctx.objectName?.(id) ?? id}', that is not ${kind}`;
}

/**
 * Why `mod` is disabled as Blender's is_disabled of its type decides (see ModifierDef.disabled),
 * or null (also for parameters that do not validate, which evaluation reports instead).
 */
export function modifierDisabledReason(mod: ModifierData, ctx: ModifierDisabledContext): string | null {
  const def = registry.get(mod.type);
  if (!def?.disabled) return null;
  const parsed = def.schema.safeParse(mod.params ?? {});
  return parsed.success ? def.disabled(parsed.data, ctx) : null;
}

/**
 * What a disabled modifier does, as Apply's refusal, get_scene's problems and the Modifiers tab say
 * it: "the <label> modifier '<name>' <reason>, so it changes nothing" (see
 * {@link modifierDisabledReason}), or null when it is not disabled.
 */
export function modifierDisabledMessage(mod: ModifierData, ctx: ModifierDisabledContext): string | null {
  const reason = modifierDisabledReason(mod, ctx);
  if (!reason) return null;
  return `the ${registry.get(mod.type)?.label ?? mod.type} modifier '${mod.name}' ${reason}, so it changes nothing`;
}

/**
 * The type of object `id` as an evaluation context tells it (see ModifierContext.getObjectType):
 * without object types, an armature (with a pose) or a curve (with a path) where the context's
 * accessors make that certain, else not known (undefined).
 */
function objectTypeIn(ctx: ModifierContext, id: string): string | null | undefined {
  if (ctx.getObjectType) return ctx.getObjectType(id);
  if (ctx.getArmature?.(id)) return 'ARMATURE';
  if (ctx.getCurvePath?.(id)) return 'CURVE';
  return undefined;
}

const registry = new Map<string, ModifierDef>();

export function registerModifier<S extends z.ZodObject<any>>(def: ModifierDef<S>): void {
  registry.set(def.type, def as unknown as ModifierDef);
}

export function getModifierDef(type: string): ModifierDef | undefined {
  return registry.get(type);
}

export function listModifierDefs(): ModifierDef[] {
  return [...registry.values()];
}

/** Default parameters for a modifier type (empty object for unknown types). */
export function defaultModifierParams(type: string): Record<string, unknown> {
  const def = registry.get(type);
  return def ? (def.schema.parse({}) as Record<string, unknown>) : {};
}

export function isModifierTimeDependent(mod: ModifierData): boolean {
  const def = registry.get(mod.type);
  if (!def?.timeDependent) return false;
  if (typeof def.timeDependent === 'boolean') return def.timeDependent;
  try {
    return def.timeDependent(def.schema.parse(mod.params ?? {}));
  } catch {
    return false;
  }
}

export function modifierDependencies(mod: ModifierData): string[] {
  const def = registry.get(mod.type);
  if (!def?.dependencies) return [];
  try {
    return def.dependencies(def.schema.parse(mod.params ?? {})).filter(Boolean);
  } catch {
    return [];
  }
}

export interface ModifierStackResult {
  mesh: MeshData;
  errors: { modifierId: string; message: string }[];
}

/** Whether a modifier is active in the given evaluation mode. */
export function isModifierEnabled(
  mod: ModifierData,
  ctx: Pick<ModifierContext, 'forRender' | 'editMode'>,
): boolean {
  if (ctx.forRender) return mod.show_render !== false;
  if (mod.show_viewport === false) return false;
  if (ctx.editMode && mod.show_in_editmode === false) return false;
  return true;
}

/**
 * Applies the enabled modifiers in order, as Blender's modifier stack does: those disabled in the
 * mode evaluated and those Blender's is_disabled of their type disables (ModifierDef.disabled) are
 * left out (BKE_modifier_is_enabled). Failing modifiers are skipped and reported.
 */
export function evaluateModifierStack(
  mesh: MeshData,
  modifiers: ModifierData[],
  ctx: ModifierContext,
): ModifierStackResult {
  let cur = mesh;
  const errors: ModifierStackResult['errors'] = [];
  const disabledCtx: ModifierDisabledContext = {
    forRender: ctx.forRender,
    objectType: (id) => objectTypeIn(ctx, id),
  };
  for (const mod of modifiers) {
    if (!isModifierEnabled(mod, ctx)) continue;
    const def = registry.get(mod.type);
    if (!def) {
      errors.push({ modifierId: mod.id, message: `Unknown modifier type ${mod.type}` });
      continue;
    }
    const parsed = def.schema.safeParse(mod.params ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(params)'}: ${i.message}`)
        .join('; ');
      errors.push({ modifierId: mod.id, message: `Invalid parameters: ${issues}` });
      continue;
    }
    if (def.disabled?.(parsed.data, disabledCtx)) continue;
    try {
      cur = def.apply(cur, parsed.data, ctx);
    } catch (err) {
      errors.push({ modifierId: mod.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { mesh: cur, errors };
}
