import { z } from 'zod';
import type { Vec3 } from '../math/types';
import { invert4 } from '../math/mat4';
import { transformPoint3, transformDirection3 } from '../math/vec3';
import { cloneMesh } from '../mesh/types';
import {
  applyPaintDab,
  applySculptDab,
  beginGrab,
  createSculptCache,
  type SculptBrush,
} from '../mesh/sculpt';
import { defineOperator, type OperatorRegistry } from './registry';
import { OperatorError, type OperatorContext } from './context';
import { vec3 } from './helpers';

function target(ctx: OperatorContext, ref?: string) {
  const o = ref
    ? ctx.doc.resolveObject(ref)
    : ctx.state.activeId
      ? ctx.doc.getObject(ctx.state.activeId)
      : null;
  if (!o || o.type !== 'MESH' || !o.data) throw new OperatorError('A mesh object is required', 'POLL_FAILED');
  const mesh = ctx.doc.getMesh(o.data);
  if (!mesh) throw new OperatorError('Mesh data missing');
  const world = ctx.doc.worldMatrix(o.id);
  const inv = invert4(world);
  const scale =
    Math.cbrt(
      Math.abs(
        world[0] * (world[5] * world[10] - world[6] * world[9]) -
          world[4] * (world[1] * world[10] - world[2] * world[9]) +
          world[8] * (world[1] * world[6] - world[2] * world[5]),
      ),
    ) || 1;
  return { o, mesh, inv, scale };
}

/** Headless sculpt / paint operators (the interactive brushes live in the viewport). */
export function registerSculptOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'sculpt.brush_stroke',
      label: 'Sculpt Stroke',
      description:
        'Apply sculpt brush dabs to a mesh object. points are world-space dab centers along the stroke; radius in meters; strength 0..1. Brushes: DRAW, CLAY, INFLATE, SMOOTH, FLATTEN, PINCH, GRAB (GRAB moves vertices near the first point by grab_delta).',
      category: 'Sculpt',
      schema: z.object({
        object: z.string().optional(),
        brush: z.enum(['DRAW', 'CLAY', 'INFLATE', 'SMOOTH', 'FLATTEN', 'PINCH', 'GRAB']).default('DRAW'),
        points: z.array(vec3).min(1),
        radius: z.number().positive().default(0.5),
        strength: z.number().min(0).max(1).default(0.5),
        invert: z.boolean().default(false),
        symmetry_x: z.boolean().default(false),
        grab_delta: vec3.optional(),
      }),
      execute(ctx, p) {
        const t = target(ctx, p.object);
        const m = cloneMesh(t.mesh);
        const cache = createSculptCache(m);
        const radius = p.radius / t.scale;
        const pts = p.points.map((q) => transformPoint3(t.inv, q as Vec3));
        let n = 0;
        if (p.brush === 'GRAB') {
          beginGrab(m, cache, pts[0], radius, p.symmetry_x);
          const d = transformDirection3(t.inv, (p.grab_delta ?? [0, 0, 0]) as Vec3);
          n = applySculptDab(m, cache, {
            brush: 'GRAB',
            center: pts[0],
            radius,
            strength: p.strength,
            grabDelta: d,
            symmetryX: p.symmetry_x,
          });
        } else
          for (const c of pts)
            n += applySculptDab(m, cache, {
              brush: p.brush as SculptBrush,
              center: c,
              radius,
              strength: p.strength,
              invert: p.invert,
              symmetryX: p.symmetry_x,
            });
        ctx.doc.setMesh(t.o.data!, m);
        return { affected: n };
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'paint.vertex_color_stroke',
      label: 'Vertex Paint Stroke',
      description: 'Paint vertex colors on a mesh around world-space points (color is linear RGBA 0..1).',
      category: 'Paint',
      schema: z.object({
        object: z.string().optional(),
        points: z.array(vec3).min(1),
        radius: z.number().positive().default(0.5),
        strength: z.number().min(0).max(1).default(1),
        color: z.tuple([z.number(), z.number(), z.number(), z.number()]).default([1, 0, 0, 1]),
        symmetry_x: z.boolean().default(false),
      }),
      execute(ctx, p) {
        const t = target(ctx, p.object);
        const m = cloneMesh(t.mesh);
        let n = 0;
        for (const q of p.points)
          n += applyPaintDab(
            m,
            transformPoint3(t.inv, q as Vec3),
            p.radius / t.scale,
            p.color,
            p.strength,
            p.symmetry_x,
          );
        ctx.doc.setMesh(t.o.data!, m);
        return { affected: n };
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'paint.vertex_color_set',
      label: 'Set Vertex Colors',
      description:
        'Fill all vertex colors of a mesh object with one color (or remove the color layer with clear=true).',
      category: 'Paint',
      schema: z.object({
        object: z.string().optional(),
        color: z.tuple([z.number(), z.number(), z.number(), z.number()]).default([1, 1, 1, 1]),
        clear: z.boolean().default(false),
      }),
      execute(ctx, p) {
        const t = target(ctx, p.object);
        const m = cloneMesh(t.mesh);
        const n = m.positions.length / 3;
        m.colors = p.clear ? null : Array.from({ length: n * 4 }, (_, i) => p.color[i % 4]);
        ctx.doc.setMesh(t.o.data!, m);
      },
    }),
  );
}
