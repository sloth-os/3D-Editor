import { z } from 'zod';
import type { MaterialData, ObjectType } from '../doc/types';
import { cloneMesh } from '../mesh/types';
import { defineOperator, type OperatorRegistry } from './registry';
import { OperatorError, type OperatorContext } from './context';
import {
  activeObject,
  editTarget,
  commitEdit,
  resolveObjectIds,
  selectedObjects,
  vec3,
  vec4,
} from './helpers';

const materialProps = {
  base_color: vec4.optional().describe('Linear RGBA'),
  metallic: z.number().min(0).max(1).optional(),
  roughness: z.number().min(0).max(1).optional(),
  ior: z.number().min(1).max(4).optional(),
  transmission: z.number().min(0).max(1).optional(),
  emission_color: vec3.optional(),
  emission_strength: z.number().min(0).optional(),
  alpha: z.number().min(0).max(1).optional(),
  blend_method: z.enum(['OPAQUE', 'CLIP', 'BLEND']).optional(),
  coat_weight: z.number().min(0).max(1).optional(),
  coat_roughness: z.number().min(0).max(1).optional(),
  sheen_weight: z.number().min(0).max(1).optional(),
  use_backface_culling: z.boolean().optional(),
};

function pickDefined(p: Record<string, unknown>, keys: string[]): Partial<MaterialData> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (p[k] !== undefined) out[k] = p[k];
  return out as Partial<MaterialData>;
}

function resolveMaterial(ctx: OperatorContext, ref: string): string {
  if (ctx.doc.getMaterial(ref)) return ref;
  const m = ctx.doc.listMaterials().find((x) => x.name === ref);
  if (!m) throw new OperatorError(`Material '${ref}' not found`, 'NOT_FOUND');
  return m.id;
}

/** Object types whose geometry has material slots (meshes, and curves/text through their splines). */
function hasMaterialSlots(type: ObjectType): boolean {
  return type === 'MESH' || type === 'CURVE' || type === 'FONT';
}

export function registerMaterialOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'material.new',
      label: 'New Material',
      description:
        'Create a new principled material. With assign=true it is put into the active material slot of the selected objects (a slot is added if they have none).',
      category: 'Material',
      schema: z.object({
        name: z.string().default('Material'),
        assign: z.boolean().default(true),
        ...materialProps,
      }),
      execute(ctx, p) {
        const id = ctx.doc.addMaterial({ name: p.name, ...pickDefined(p, Object.keys(materialProps)) });
        if (p.assign) {
          for (const o of selectedObjects(ctx)) {
            if (!hasMaterialSlots(o.type)) continue;
            const slots = o.material_slots.length ? [...o.material_slots] : [null];
            const idx = Math.max(
              0,
              slots.findIndex((s) => s === null),
            );
            slots[idx === -1 ? 0 : idx] = id;
            ctx.doc.updateObject(o.id, { material_slots: slots });
          }
        }
        return { material: id, name: ctx.doc.getMaterial(id)?.name };
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'material.update',
      label: 'Edit Material',
      description: 'Change properties of a material (id or name).',
      category: 'Material',
      schema: z.object({ material: z.string(), name: z.string().optional(), ...materialProps }),
      execute(ctx, p) {
        const id = resolveMaterial(ctx, p.material);
        ctx.doc.updateMaterial(id, {
          ...pickDefined(p, Object.keys(materialProps)),
          ...(p.name ? { name: p.name } : {}),
        });
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'material.delete',
      label: 'Delete Material',
      description: 'Delete a material; slots using it become empty.',
      category: 'Material',
      schema: z.object({ material: z.string() }),
      execute(ctx, p) {
        ctx.doc.removeMaterial(resolveMaterial(ctx, p.material));
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'object.material_assign',
      label: 'Assign Material',
      description:
        'Put a material (id or name) into slot `slot` of the given/selected mesh objects (slots are created as needed).',
      category: 'Material',
      schema: z.object({
        material: z.string().nullable(),
        objects: z.array(z.string()).optional(),
        slot: z.number().int().min(0).default(0),
      }),
      execute(ctx, p) {
        const mat = p.material ? resolveMaterial(ctx, p.material) : null;
        for (const id of resolveObjectIds(ctx, p.objects)) {
          const o = ctx.doc.getObject(id)!;
          const slots = [...o.material_slots];
          while (slots.length <= p.slot) slots.push(null);
          slots[p.slot] = mat;
          ctx.doc.updateObject(id, { material_slots: slots });
        }
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'object.material_slot_add',
      label: 'Add Material Slot',
      description: 'Add an empty material slot to the active mesh, curve or text object.',
      category: 'Material',
      schema: z.object({}),
      poll: (ctx) => {
        const o = activeObject(ctx);
        return o && hasMaterialSlots(o.type) ? true : 'Active object must be a mesh, curve or text object';
      },
      execute(ctx) {
        const o = activeObject(ctx)!;
        ctx.doc.updateObject(o.id, { material_slots: [...o.material_slots, null] });
        return { index: o.material_slots.length };
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'object.material_slot_remove',
      label: 'Remove Material Slot',
      description:
        'Remove a material slot from the active object; faces (meshes) or splines (curves and text) using it fall ' +
        'back to slot 0.',
      category: 'Material',
      schema: z.object({ index: z.number().int().min(0).optional() }),
      poll: (ctx) => ((activeObject(ctx)?.material_slots.length ?? 0) > 0 ? true : 'No material slots'),
      execute(ctx, p) {
        const o = activeObject(ctx)!;
        const index = p.index ?? o.material_slots.length - 1;
        if (index >= o.material_slots.length)
          throw new OperatorError('Slot index out of range', 'INVALID_PARAMS');
        ctx.doc.updateObject(o.id, { material_slots: o.material_slots.filter((_, i) => i !== index) });
        const remap = (mi: number) => (mi === index ? 0 : mi > index ? mi - 1 : mi);
        if (o.data && o.type === 'MESH') {
          const m = cloneMesh(ctx.doc.getMesh(o.data)!);
          m.faceMaterials = m.faceMaterials.map(remap);
          ctx.doc.setMesh(o.data, m);
        } else if (o.data && (o.type === 'CURVE' || o.type === 'FONT')) {
          const c = ctx.doc.getCurve(o.data);
          if (c && c.splines.some((sp) => remap(sp.material_index) !== sp.material_index))
            ctx.doc.updateCurve(o.data, {
              splines: c.splines.map((sp) => ({ ...sp, material_index: remap(sp.material_index) })),
            });
        }
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'object.material_slot_assign',
      label: 'Assign Material Slot',
      description: 'Edit Mode: assign the given material slot to the selected faces.',
      category: 'Material',
      schema: z.object({ index: z.number().int().min(0).default(0) }),
      poll: (ctx) => (ctx.state.mode === 'EDIT' ? true : 'Requires Edit Mode'),
      execute(ctx, p) {
        const t = editTarget(ctx);
        const m = cloneMesh(t.mesh);
        for (const f of t.selection.faces) if (f < m.faces.length) m.faceMaterials[f] = p.index;
        commitEdit(ctx, t, m, t.selection);
      },
    }),
  );
}
