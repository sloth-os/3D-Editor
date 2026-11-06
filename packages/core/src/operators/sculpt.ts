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
  const rgba = z.union([
    z.tuple([z.number(), z.number(), z.number()]),
    z.tuple([z.number(), z.number(), z.number(), z.number()]),
  ]);
  reg.register(
    defineOperator({
      id: 'paint.vertex_color_set_data',
      label: 'Set Vertex Colors from Data',
      description:
        'Write exact per-vertex colors into the vertex color layer of a mesh object in one call (one undo step), ' +
        'e.g. terrain colors computed from height and slope. Colors are linear RGBA (or RGB, alpha 1) floats ' +
        '0..1 (divide 0..255 values by 255). Give ONE of: `colors` with one color per vertex in vertex order (as ' +
        'get_mesh_data lists them; the count must match, or pass `start` to write a contiguous run from that ' +
        'vertex index on); `colors` + `indices` (one color per listed vertex index, or a single color for all of ' +
        'them); or `ranges` ([{start, count, color}], a color per run of vertex indices). Other vertices keep ' +
        'their colors; a mesh without a color layer first gets an all-white one. The renderers and the viewport ' +
        'MULTIPLY the material base color by the vertex color (use a white base color to see the colors as ' +
        'they are); faces blend between their vertices. Objects sharing the mesh change together. Returns ' +
        '{object, vertices (mesh vertex count), set (vertices written)}.',
      category: 'Paint',
      schema: z.object({
        object: z.string().optional().describe('Mesh object (id or name); default: the active object'),
        colors: z
          .array(rgba)
          .optional()
          .describe('Linear [r, g, b, a] (or [r, g, b]) 0..1 per vertex; see the description for the forms'),
        indices: z
          .array(z.number().int().min(0))
          .optional()
          .describe('Vertex indices the `colors` go to (same length as colors, or one color for all)'),
        start: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('With `colors` and no `indices`: index of the vertex that gets colors[0] (a contiguous run)'),
        ranges: z
          .array(
            z.object({
              start: z.number().int().min(0).describe('First vertex index of the run'),
              count: z.number().int().min(1).describe('Number of vertices in the run'),
              color: rgba.describe('Linear [r, g, b, a] (or [r, g, b]) 0..1'),
            }),
          )
          .optional()
          .describe('Runs of vertex indices with one color each (instead of colors / indices)'),
      }),
      execute(ctx, p) {
        const t = target(ctx, p.object);
        const n = t.mesh.positions.length / 3;
        const check = (c: readonly number[], where: string): number[] => {
          for (const v of c)
            if (!Number.isFinite(v) || v < 0 || v > 1)
              throw new OperatorError(
                `${where} = [${c.join(', ')}]: colors are linear 0..1 floats` +
                  (v > 1 && v <= 255 ? ' (divide 0..255 values by 255)' : ''),
                'INVALID_PARAMS',
              );
          return c.length === 3 ? [c[0], c[1], c[2], 1] : [c[0], c[1], c[2], c[3]];
        };
        const writes: [number, number[]][] = [];
        const index = (i: number, where: string) => {
          if (i >= n)
            throw new OperatorError(
              `${where} = ${i} is out of range: '${t.o.name}' has ${n} vertices (0 … ${n - 1})`,
              'INVALID_PARAMS',
            );
          return i;
        };
        if (p.ranges) {
          if (p.colors || p.indices || p.start !== undefined)
            throw new OperatorError('Pass `ranges` or `colors` (with indices / start), not both', 'INVALID_PARAMS');
          p.ranges.forEach((r, k) => {
            const c = check(r.color, `ranges[${k}].color`);
            index(r.start + r.count - 1, `ranges[${k}].start + count - 1`);
            for (let i = r.start; i < r.start + r.count; i++) writes.push([i, c]);
          });
        } else if (p.colors) {
          const colors = p.colors.map((c, k) => check(c, `colors[${k}]`));
          if (p.indices) {
            if (p.start !== undefined)
              throw new OperatorError('Pass `indices` or `start`, not both', 'INVALID_PARAMS');
            if (colors.length !== 1 && colors.length !== p.indices.length)
              throw new OperatorError(
                `colors has ${colors.length} entries for ${p.indices.length} indices: pass one color per index ` +
                  'or a single color for all of them',
                'INVALID_PARAMS',
              );
            p.indices.forEach((i, k) => writes.push([index(i, `indices[${k}]`), colors[colors.length === 1 ? 0 : k]]));
          } else {
            const start = p.start ?? 0;
            if (p.start === undefined && colors.length !== n)
              throw new OperatorError(
                `colors has ${colors.length} entries but '${t.o.name}' has ${n} vertices: pass one color per ` +
                  'vertex, `start` for a contiguous run, or `indices` / `ranges` for some vertices',
                'INVALID_PARAMS',
              );
            index(start + colors.length - 1, 'start + colors.length - 1');
            colors.forEach((c, k) => writes.push([start + k, c]));
          }
        } else
          throw new OperatorError(
            'Nothing to set: pass `colors` (per vertex, or with indices / start) or `ranges`',
            'INVALID_PARAMS',
          );
        const m = cloneMesh(t.mesh);
        const cols = m.colors && m.colors.length === n * 4 ? m.colors : new Array<number>(n * 4).fill(1);
        for (const [i, c] of writes) for (let k = 0; k < 4; k++) cols[i * 4 + k] = c[k];
        m.colors = cols;
        ctx.doc.setMesh(t.o.data!, m);
        return { object: t.o.name, vertices: n, set: new Set(writes.map((w) => w[0])).size };
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
