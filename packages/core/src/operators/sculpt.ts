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
  if (ref && !o) throw new OperatorError(`Object '${ref}' not found`, 'NOT_FOUND');
  if (!o)
    throw new OperatorError('No active object: pass `object` (a mesh object id or name)', 'POLL_FAILED');
  if (o.type !== 'MESH' || !o.data)
    throw new OperatorError(
      `Object '${o.name}' is a ${o.type} object; sculpting and painting need a mesh`,
      'POLL_FAILED',
    );
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
        'Apply sculpt brush dabs to a mesh object (one undo step). Each entry of `points` is one dab, applied in ' +
        'order; a dab affects the vertices inside a SPHERE of `radius` around it (world space, so the point must ' +
        'lie on or near the surface: get the height with scene.raycast) with a smooth falloff (full effect at the ' +
        'center, none at the radius). The surface normal used by DRAW/CLAY/FLATTEN is the average normal of the ' +
        'affected vertices, measured once before the stroke. Brushes: DRAW raises the surface along that normal by ' +
        'up to 0.15 × strength × radius per dab (radius 4, strength 0.5: 0.3 m at the center; invert digs); CLAY ' +
        'raises only what lies below the average plane (fills dips); INFLATE pushes every vertex along its own ' +
        'normal (invert shrinks); SMOOTH moves vertices toward the average of their neighbours by strength × ' +
        'falloff per dab; FLATTEN pulls vertices toward the average plane through the affected area by strength × ' +
        'falloff per dab, so it converges to that (possibly tilted) plane and cannot level a pad on a slope — for ' +
        'level ground use GRAB, edit the vertices with edit_mesh, or set a foundation block into the ground; PINCH ' +
        'pulls vertices toward the dab center (invert pushes them apart); GRAB takes the vertices around the FIRST ' +
        'point (other points are ignored) and moves each by grab_delta × falloff: the precise brush for shaping ' +
        'terrain. Returns {affected}: the number of vertex influences applied.',
      category: 'Sculpt',
      schema: z.object({
        object: z.string().optional().describe('Mesh object (id or name); default: the active object'),
        brush: z
          .enum(['DRAW', 'CLAY', 'INFLATE', 'SMOOTH', 'FLATTEN', 'PINCH', 'GRAB'])
          .default('DRAW')
          .describe('Brush type (see the operator description for what each one does)'),
        points: z
          .array(vec3)
          .min(1)
          .describe(
            'World-space dab centers [x, y, z] in meters, applied in order; they must be on or near the surface ' +
              '(the brush is a sphere, a dab hovering above the surface reaches few vertices). GRAB uses only the first',
          ),
        radius: z
          .number()
          .positive()
          .default(0.5)
          .describe(
            'Brush radius in meters (world space): vertices farther than this from a dab are not affected',
          ),
        strength: z
          .number()
          .min(0)
          .max(1)
          .default(0.5)
          .describe(
            'Brush strength 0..1 per dab: DRAW/CLAY/INFLATE move up to 0.15 × strength × radius at the center; ' +
              'SMOOTH/FLATTEN move this fraction of the way to the target; GRAB ignores it (grab_delta is exact)',
          ),
        invert: z
          .boolean()
          .default(false)
          .describe(
            'Reverse the effect (Ctrl in Blender): DRAW digs, INFLATE deflates, PINCH spreads; not GRAB/SMOOTH',
          ),
        symmetry_x: z
          .boolean()
          .default(false)
          .describe("Mirror every dab across the object's local X = 0 plane"),
        grab_delta: vec3
          .optional()
          .describe(
            'GRAB only: world-space offset in meters for the vertices at the first point (scaled by the falloff, so ' +
              'the center moves by exactly this much)',
          ),
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
      description:
        'Paint vertex colors on a mesh around world-space points (one undo step). Each point is a dab blending the ' +
        'colors of the vertices inside a sphere of `radius` toward `color` by strength × falloff (full at the ' +
        'center, none at the radius); a mesh without colors first gets an all-white color layer. The renderers ' +
        'and the viewport MULTIPLY the material base color by the vertex color (white leaves the material as it ' +
        'is), so use a white or light base color to see painted colors unchanged. Colors are per vertex: faces ' +
        'blend between their corners, so the mesh needs enough vertices for sharp patterns. Returns {affected}.',
      category: 'Paint',
      schema: z.object({
        object: z.string().optional().describe('Mesh object (id or name); default: the active object'),
        points: z
          .array(vec3)
          .min(1)
          .describe('World-space dab centers [x, y, z] in meters; they must be on or near the surface'),
        radius: z.number().positive().default(0.5).describe('Brush radius in meters (world space)'),
        strength: z
          .number()
          .min(0)
          .max(1)
          .default(1)
          .describe('How far each dab blends toward `color` at its center (1 = replace)'),
        color: z
          .tuple([z.number(), z.number(), z.number(), z.number()])
          .default([1, 0, 0, 1])
          .describe('Linear RGBA 0..1 (multiplies the material base color when rendered)'),
        symmetry_x: z
          .boolean()
          .default(false)
          .describe("Mirror every dab across the object's local X = 0 plane"),
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
        'Fill all vertex colors of a mesh object with one color (or remove the color layer with clear=true). The ' +
        'renderers multiply the material base color by the vertex colors, so white is the neutral fill.',
      category: 'Paint',
      schema: z.object({
        object: z.string().optional().describe('Mesh object (id or name); default: the active object'),
        color: z
          .tuple([z.number(), z.number(), z.number(), z.number()])
          .default([1, 1, 1, 1])
          .describe('Linear RGBA 0..1 for every vertex'),
        clear: z.boolean().default(false).describe('Remove the vertex color layer instead of filling it'),
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
