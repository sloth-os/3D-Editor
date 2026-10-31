import type { z } from 'zod';
import type { Mat4 } from '../math/types';
import type { MeshData } from '../mesh/types';
import type { ModifierData, VertexGroupData } from '../doc/types';
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
  /** Vertex groups of the owner's mesh; only meaningful while the vertex count is unchanged. */
  vertexGroups?: readonly VertexGroupData[];
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
  /** Pure function: must not mutate `mesh`. */
  apply(mesh: MeshData, params: z.infer<S>, ctx: ModifierContext): MeshData;
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

/** Applies the enabled modifiers in order. Failing modifiers are skipped and reported. */
export function evaluateModifierStack(
  mesh: MeshData,
  modifiers: ModifierData[],
  ctx: ModifierContext,
): ModifierStackResult {
  let cur = mesh;
  const errors: ModifierStackResult['errors'] = [];
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
    try {
      cur = def.apply(cur, parsed.data, ctx);
    } catch (err) {
      errors.push({ modifierId: mod.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { mesh: cur, errors };
}
