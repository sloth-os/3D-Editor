import { z } from 'zod';
import type { DatablockKind } from '../doc/types';
import { ANIMATABLE } from '../anim/properties';
import { defineOperator, type OperatorRegistry } from './registry';
import { OperatorError, type OperatorContext } from './context';
import { rekeyAnimated } from './anim';
import type { AnimTargetType } from '../doc/types';

const KINDS = ['objects', 'meshes', 'materials', 'lights', 'cameras', 'images', 'collections', 'scene', 'render', 'world'] as const;

/** Fields that must not be changed through the generic property setter. */
const READONLY = new Set(['id', 'data', 'modifiers']);

function resolveBlock(ctx: OperatorContext, kind: DatablockKind, ref: string): string {
  if (ctx.doc.getBlock(kind, ref)) return ref;
  const byName = (() => {
    switch (kind) {
      case 'objects':
        return ctx.doc.findObjectByName(ref)?.id;
      case 'materials':
        return ctx.doc.listMaterials().find((m) => m.name === ref)?.id;
      case 'meshes':
        return ctx.doc.listMeshBlocks().find((m) => m.name === ref)?.id;
      case 'collections':
        return ctx.doc.listCollections().find((c) => c.name === ref)?.id;
      case 'images':
        return ctx.doc.listImages().find((c) => c.name === ref)?.id;
      default:
        return undefined;
    }
  })();
  if (!byName) throw new OperatorError(`${kind} '${ref}' not found`, 'NOT_FOUND');
  return byName;
}

const ANIM_TYPE: Partial<Record<string, AnimTargetType>> = {
  objects: 'object',
  materials: 'material',
  lights: 'light',
  cameras: 'camera',
  world: 'world',
};

/**
 * Generic property setter (like assigning `bpy.data.<kind>[name].<prop> = value`).
 * Covers every scalar/vector field of every datablock and the scene/render/world settings.
 */
export function registerDataOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'data.set_property',
      label: 'Set Property',
      description:
        'Set properties of a datablock: kind objects|meshes|materials|lights|cameras|images|collections|scene|render|world, target id or name (ignored for scene/render/world), values = { field: value }. Field names follow Blender (e.g. location, rotation_euler, hide_viewport, energy, lens, base_color, resolution_x, frame_end).',
      category: 'Data',
      schema: z.object({
        kind: z.enum(KINDS),
        target: z.string().optional(),
        values: z.record(z.string(), z.unknown()),
      }),
      execute(ctx, p) {
        for (const k of Object.keys(p.values)) if (READONLY.has(k)) throw new OperatorError(`Field '${k}' cannot be set directly`, 'INVALID_PARAMS');
        if (p.kind === 'scene') ctx.doc.updateScene(p.values);
        else if (p.kind === 'render') ctx.doc.updateRender(p.values);
        else if (p.kind === 'world') ctx.doc.updateWorld(p.values);
        else {
          if (!p.target) throw new OperatorError('target is required', 'INVALID_PARAMS');
          const id = resolveBlock(ctx, p.kind, p.target);
          const current = ctx.doc.getBlock(p.kind, id)!;
          for (const [k, v] of Object.entries(p.values)) {
            if (!(k in current)) throw new OperatorError(`Unknown field '${k}' for ${p.kind}`, 'INVALID_PARAMS');
            const cur = current[k];
            if (cur !== null && v !== null && typeof cur !== typeof v) throw new OperatorError(`Field '${k}' expects ${typeof cur}`, 'INVALID_PARAMS');
            if (Array.isArray(cur) && (!Array.isArray(v) || (cur.length && v.length !== cur.length)))
              throw new OperatorError(`Field '${k}' expects an array of length ${cur.length}`, 'INVALID_PARAMS');
          }
          ctx.doc.updateBlockByKind(p.kind, id, p.values);
          const animType = ANIM_TYPE[p.kind];
          if (animType) {
            const animatable = Object.keys(p.values).filter((k) => k in (ANIMATABLE[animType] ?? {}));
            if (animatable.length) rekeyAnimated(ctx, animType, id, animatable);
          }
        }
      },
    }),
  );
}
