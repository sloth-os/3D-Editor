import { z } from 'zod';
import type { ModifierData, ObjectData } from '../doc/types';
import { cloneMesh } from '../mesh/types';
import {
  defaultModifierName,
  evaluateModifierStack,
  getModifierDef,
  isModifierEnabled,
  listModifierDefs,
  modifierObjectParams,
  registerBuiltinModifiers,
  type ModifierDef,
} from '../modifiers';
import { SceneEvaluator } from '../eval/evaluate';
import { newId } from '../util/id';
import { uniqueName } from '../util/names';
import { cloneJson } from '../util/json';
import type { OperatorContext } from './context';
import { OperatorError } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { activeObject } from './helpers';

const objectRef = z.string().optional().describe('Object id or name (default: the active object)');
const modifierRef = z.string().describe('Modifier id or name');

/** Types whose modifiers start disabled in edit mode (like Blender). */
const EDITMODE_OFF = new Set(['BOOLEAN', 'BUILD', 'DECIMATE']);

/**
 * The object whose modifier stack an operator edits: mesh objects, and (like Blender) curve and text
 * objects, whose modifiers act on the generated geometry (the surface, or the wire of a curve
 * without one).
 */
function targetObject(ctx: OperatorContext, ref: string | undefined): ObjectData {
  const o = ref ? ctx.doc.resolveObject(ref) : activeObject(ctx);
  if (!o) {
    if (ref) throw new OperatorError(`Object '${ref}' not found`, 'NOT_FOUND');
    throw new OperatorError('No active object (pass `object`)', 'POLL_FAILED');
  }
  if (!['MESH', 'CURVE', 'FONT'].includes(o.type) || !o.data) {
    throw new OperatorError(
      `Object '${o.name}' is a ${o.type} object; only mesh, curve and text objects can have modifiers`,
      'POLL_FAILED',
    );
  }
  return o;
}

function findModifier(o: ObjectData, ref: string): number {
  let i = o.modifiers.findIndex((m) => m.id === ref);
  if (i < 0) i = o.modifiers.findIndex((m) => m.name === ref);
  if (i < 0) {
    const have = o.modifiers.map((m) => `'${m.name}'`).join(', ') || 'none';
    throw new OperatorError(`Modifier '${ref}' not found on '${o.name}' (modifiers: ${have})`, 'NOT_FOUND');
  }
  return i;
}

/** Resolves a modifier type by id ('SUBSURF'), case-insensitively, or by label ('Subdivision Surface'). */
function resolveType(type: string): ModifierDef {
  registerBuiltinModifiers();
  const direct = getModifierDef(type) ?? getModifierDef(type.toUpperCase());
  if (direct) return direct;
  const lower = type.toLowerCase();
  const byLabel = listModifierDefs().find(
    (d) => d.label.toLowerCase() === lower || defaultModifierName(d.type).toLowerCase() === lower,
  );
  if (byLabel) return byLabel;
  const valid = listModifierDefs()
    .map((d) => d.type)
    .join(', ');
  throw new OperatorError(`Unknown modifier type '${type}'. Valid types: ${valid}`, 'INVALID_PARAMS');
}

/**
 * Merges a partial parameter patch into `current` and validates it with the type's schema. Object
 * references in the patch may be given by id or name and are stored as ids.
 */
function validateParams(
  ctx: OperatorContext,
  owner: ObjectData,
  def: ModifierDef,
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const keys = Object.keys(def.schema.shape);
  const unknown = Object.keys(patch).filter((k) => !keys.includes(k));
  if (unknown.length) {
    throw new OperatorError(
      `Unknown parameter${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `'${k}'`).join(', ')} for ${def.type} modifier. ` +
        `Valid parameters: ${keys.join(', ')}`,
      'INVALID_PARAMS',
    );
  }
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(current)) if (keys.includes(k)) merged[k] = v;
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) merged[k] = v;
  for (const k of modifierObjectParams(def.type)) {
    const v = patch[k];
    if (typeof v !== 'string') continue;
    if (v === '') {
      merged[k] = null;
      continue;
    }
    const ref = ctx.doc.resolveObject(v);
    if (!ref) throw new OperatorError(`Object '${v}' (parameter '${k}') not found`, 'NOT_FOUND');
    if (ref.id === owner.id)
      throw new OperatorError(
        `Parameter '${k}' cannot reference the modifier's own object`,
        'INVALID_PARAMS',
      );
    merged[k] = ref.id;
  }
  const res = def.schema.safeParse(merged);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new OperatorError(`Invalid ${def.type} parameters: ${msg}`, 'INVALID_PARAMS');
  }
  return cloneJson(res.data as Record<string, unknown>);
}

function uniqueModifierName(o: ObjectData, base: string, except = -1): string {
  return uniqueName(base, new Set(o.modifiers.filter((_, i) => i !== except).map((m) => m.name)));
}

function writeModifiers(ctx: OperatorContext, o: ObjectData, modifiers: ModifierData[]): void {
  ctx.doc.updateObject(o.id, { modifiers });
}

/** Makes the object's mesh data single-user (copies shared mesh data) and returns its id. */
function singleUserMesh(ctx: OperatorContext, o: ObjectData): string {
  if (!o.data) throw new OperatorError('Object has no mesh data');
  if (ctx.doc.dataUsers(o.data) <= 1) return o.data;
  const copy = ctx.doc.addMesh(ctx.doc.getMeshBlock(o.data)?.name ?? o.name, ctx.doc.getMeshCopy(o.data)!);
  ctx.doc.updateObject(o.id, { data: copy });
  return copy;
}

export function registerModifierOperators(reg: OperatorRegistry): void {
  registerBuiltinModifiers();
  const typeList = listModifierDefs()
    .map((d) => d.type)
    .join(', ');

  reg.register(
    defineOperator({
      id: 'object.modifier_add',
      label: 'Add Modifier',
      description:
        'Add a modifier to the end of the modifier stack of a mesh, curve or text object (default: active object; ' +
        'on curves and text it acts on the generated surface, or on the wire of a curve without one, so SCREW ' +
        'revolves a profile curve). `type` is a Blender ' +
        `modifier type (${typeList}); optional initial \`params\` are validated against the type's parameters. ` +
        'Returns the new modifier id and its unique name (e.g. "Subdivision", "Subdivision.001").',
      category: 'Object',
      redoable: true,
      schema: z.object({
        type: z.string().describe(`Modifier type: ${typeList}`),
        name: z.string().optional().describe('Name for the modifier (made unique on the object)'),
        object: objectRef,
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Initial parameter values (Blender names)'),
      }),
      execute(ctx, p) {
        const def = resolveType(p.type);
        const o = targetObject(ctx, p.object);
        const params = validateParams(
          ctx,
          o,
          def,
          def.schema.parse({}) as Record<string, unknown>,
          p.params ?? {},
        );
        const mod: ModifierData = {
          id: newId(),
          name: uniqueModifierName(o, p.name?.trim() || defaultModifierName(def.type)),
          type: def.type,
          show_viewport: true,
          show_render: true,
          show_in_editmode: !EDITMODE_OFF.has(def.type),
          show_expanded: true,
          params,
        };
        writeModifiers(ctx, o, [...o.modifiers, mod]);
        return { modifier: mod.id, name: mod.name, object: o.id };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.modifier_remove',
      label: 'Remove Modifier',
      description: "Remove a modifier (id or name) from an object's stack (default: active object).",
      category: 'Object',
      schema: z.object({ modifier: modifierRef, object: objectRef }),
      execute(ctx, p) {
        const o = targetObject(ctx, p.object);
        const i = findModifier(o, p.modifier);
        const removed = o.modifiers[i];
        writeModifiers(
          ctx,
          o,
          o.modifiers.filter((_, k) => k !== i),
        );
        return { removed: removed.id, name: removed.name };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.modifier_apply',
      label: 'Apply Modifier',
      description:
        "Bake the modifier stack up to and including the given modifier into the object's mesh data (shared mesh data " +
        'is made single-user first) and remove the applied modifiers. Modifiers disabled in the viewport before it ' +
        'are skipped and kept. Not available in Edit Mode.',
      category: 'Object',
      schema: z.object({ modifier: modifierRef, object: objectRef }),
      execute(ctx, p) {
        const o = targetObject(ctx, p.object);
        if (o.type !== 'MESH')
          throw new OperatorError(
            `Modifiers of the ${o.type === 'FONT' ? 'text' : 'curve'} object '${o.name}' cannot be applied one by ` +
              'one: convert it with object.convert {target: "MESH"}, which bakes the whole modifier stack into a mesh',
            'POLL_FAILED',
          );
        if (ctx.state.mode === 'EDIT' && ctx.state.activeId === o.id) {
          throw new OperatorError('Modifiers cannot be applied in Edit Mode', 'POLL_FAILED');
        }
        const idx = findModifier(o, p.modifier);
        const target = o.modifiers[idx];
        if (!target.show_viewport) {
          throw new OperatorError(
            `Modifier '${target.name}' is disabled in the viewport; enable it before applying`,
            'FAILED',
          );
        }
        const flags = { forRender: false, editMode: false };
        const stack = o.modifiers.slice(0, idx + 1).filter((m) => isModifierEnabled(m, flags));
        const base = ctx.doc.getMesh(o.data!);
        if (!base) throw new OperatorError('Mesh data missing', 'FAILED');
        const ev = new SceneEvaluator(ctx.doc).evaluate(ctx.state.frame);
        const result = evaluateModifierStack(base, stack, {
          frame: ctx.state.frame,
          objectMatrix: ev.byId.get(o.id)?.worldMatrix ?? ctx.doc.worldMatrix(o.id),
          forRender: false,
          editMode: false,
          getObjectMesh: (id) => {
            if (id === o.id) return null;
            const e = ev.byId.get(id);
            return e?.mesh ? { mesh: e.mesh, matrix: e.worldMatrix } : null;
          },
          getObjectMatrix: (id) => ev.byId.get(id)?.worldMatrix ?? null,
          // Armature modifier: the evaluated pose (bakes the current pose into the mesh) + weights
          getArmature: (id) => {
            const e = ev.byId.get(id);
            return e?.pose ? { pose: e.pose, matrix: e.worldMatrix } : null;
          },
          vertexGroups: ctx.doc.getVertexGroups(o.data!),
        });
        if (result.errors.length) {
          const msg = result.errors
            .map(
              (e) =>
                `'${o.modifiers.find((m) => m.id === e.modifierId)?.name ?? e.modifierId}': ${e.message}`,
            )
            .join('; ');
          throw new OperatorError(`Cannot apply modifier: ${msg}`, 'FAILED');
        }
        const meshId = singleUserMesh(ctx, o);
        ctx.doc.setMesh(meshId, cloneMesh(result.mesh));
        const applied = new Set(stack.map((m) => m.id));
        writeModifiers(
          ctx,
          o,
          o.modifiers.filter((m) => !applied.has(m.id)),
        );
        return { object: o.id, mesh: meshId, applied: stack.map((m) => m.name) };
      },
    }),
  );

  const move = (
    ctx: OperatorContext,
    ref: string,
    objectRefValue: string | undefined,
    to: (from: number, len: number) => number,
  ) => {
    const o = targetObject(ctx, objectRefValue);
    const from = findModifier(o, ref);
    const target = Math.max(0, Math.min(o.modifiers.length - 1, to(from, o.modifiers.length)));
    if (target === from) {
      ctx.report('INFO', `Modifier '${o.modifiers[from].name}' is already at position ${from}`);
      return { modifier: o.modifiers[from].id, index: from };
    }
    const mods = o.modifiers.slice();
    const [mod] = mods.splice(from, 1);
    mods.splice(target, 0, mod);
    writeModifiers(ctx, o, mods);
    return { modifier: mod.id, index: target };
  };

  reg.register(
    defineOperator({
      id: 'object.modifier_move_up',
      label: 'Move Modifier Up',
      description: 'Move a modifier one position up (earlier) in the stack.',
      category: 'Object',
      schema: z.object({ modifier: modifierRef, object: objectRef }),
      execute: (ctx, p) => move(ctx, p.modifier, p.object, (i) => i - 1),
    }),
  );
  reg.register(
    defineOperator({
      id: 'object.modifier_move_down',
      label: 'Move Modifier Down',
      description: 'Move a modifier one position down (later) in the stack.',
      category: 'Object',
      schema: z.object({ modifier: modifierRef, object: objectRef }),
      execute: (ctx, p) => move(ctx, p.modifier, p.object, (i) => i + 1),
    }),
  );
  reg.register(
    defineOperator({
      id: 'object.modifier_move_to_index',
      label: 'Move Modifier to Index',
      description: 'Move a modifier to a position in the stack (0 = first; clamped to the stack size).',
      category: 'Object',
      schema: z.object({ modifier: modifierRef, index: z.number().int().min(0), object: objectRef }),
      execute: (ctx, p) => move(ctx, p.modifier, p.object, () => p.index),
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.modifier_set',
      label: 'Set Modifier Properties',
      description:
        'Change a modifier: `params` is a partial set of type-specific parameters (merged with the current values and ' +
        'validated; unknown keys are rejected with the list of valid ones), plus optional name and visibility flags ' +
        '(show_viewport, show_render, show_in_editmode, show_expanded).',
      category: 'Object',
      redoable: true,
      schema: z.object({
        modifier: modifierRef,
        object: objectRef,
        params: z.record(z.string(), z.unknown()).optional().describe('Parameters to change (Blender names)'),
        name: z.string().optional(),
        show_viewport: z.boolean().optional(),
        show_render: z.boolean().optional(),
        show_in_editmode: z.boolean().optional(),
        show_expanded: z.boolean().optional(),
      }),
      execute(ctx, p) {
        const o = targetObject(ctx, p.object);
        const i = findModifier(o, p.modifier);
        const cur = o.modifiers[i];
        const next: ModifierData = { ...cur };
        if (p.params && Object.keys(p.params).length) {
          const def = getModifierDef(cur.type);
          if (!def) throw new OperatorError(`Modifier '${cur.name}' has unknown type ${cur.type}`, 'FAILED');
          next.params = validateParams(ctx, o, def, cur.params ?? {}, p.params);
        }
        if (p.name !== undefined && p.name.trim()) next.name = uniqueModifierName(o, p.name.trim(), i);
        for (const k of ['show_viewport', 'show_render', 'show_in_editmode', 'show_expanded'] as const) {
          if (p[k] !== undefined) next[k] = p[k];
        }
        const mods = o.modifiers.slice();
        mods[i] = next;
        writeModifiers(ctx, o, mods);
        return { modifier: next.id, name: next.name, params: next.params };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.modifier_copy',
      label: 'Copy Modifier',
      description: 'Duplicate a modifier; the copy is inserted right after the original with a unique name.',
      category: 'Object',
      schema: z.object({ modifier: modifierRef, object: objectRef }),
      execute(ctx, p) {
        const o = targetObject(ctx, p.object);
        const i = findModifier(o, p.modifier);
        const src = o.modifiers[i];
        const copy: ModifierData = { ...cloneJson(src), id: newId(), name: uniqueModifierName(o, src.name) };
        const mods = o.modifiers.slice();
        mods.splice(i + 1, 0, copy);
        writeModifiers(ctx, o, mods);
        return { modifier: copy.id, name: copy.name, index: i + 1 };
      },
    }),
  );
}
