import type { ModifierData } from '../doc/types';
import type { MeshData } from '../mesh/types';
import {
  getModifierDef,
  listModifierDefs,
  registerBuiltinModifiers,
  registerModifier,
  type ModifierDef,
} from '../modifiers';

/*
 * Memory estimates of modifier evaluations, and the check a host can run before each of them.
 *
 * The server evaluates scenes in its own process (scene summaries, mesh data, operators), next to
 * every editor connection, agent session and project room. When that process runs out of
 * JavaScript heap, V8 aborts it (a fatal error, not an exception), so one Subdivision Surface of a
 * few levels too many took the whole server down. The server therefore installs a check
 * (`setGeometryMemoryCheck`): every registered modifier is then wrapped so that, before it runs,
 * the check gets its estimated peak heap and may refuse it. A refused modifier throws, so it is
 * skipped and reported as that modifier's error wherever a modifier stack is evaluated (the
 * evaluator, Apply, orco and instancing), like a modifier that fails. Without a check (the browser,
 * the server's render processes, which run out of memory on their own) modifiers run as before.
 *
 * The estimates are what the evaluation of each modifier took at the peak of the JavaScript heap,
 * measured on grids of 62,500 to 1,000,000 faces (--trace-gc), per face of the input or of the
 * result, rounded up. Modifiers that grow the mesh are estimated from their parameters
 * (Subdivision Surface levels, Array count, Mirror axes, Screw steps, …); Array with FIT_LENGTH and
 * an object offset, Bevel with limit_method ANGLE and Boolean are approximations.
 */

/** Size of a mesh for the estimates. */
export interface MeshSize {
  faces: number;
  /** Face corners: the sum of the faces' vertex counts. */
  corners: number;
  vertices: number;
  /** Size of the bounding box (Array with FIT_LENGTH), when known. */
  extent?: readonly [number, number, number];
}

/** The size of `m` for {@link estimateModifier}. */
export function meshSize(m: MeshData, withExtent = false): MeshSize {
  let corners = 0;
  for (const f of m.faces) corners += f.length;
  const size: MeshSize = { faces: m.faces.length, corners, vertices: m.positions.length / 3 };
  if (withExtent && m.positions.length) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3)
      for (let k = 0; k < 3; k++) {
        if (p[i + k] < lo[k]) lo[k] = p[i + k];
        if (p[i + k] > hi[k]) hi[k] = p[i + k];
      }
    size.extent = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  }
  return size;
}

/** The estimated result of one modifier and the JavaScript heap its evaluation takes. */
export interface ModifierEstimate {
  /** Estimated size of the result. */
  result: MeshSize;
  /**
   * JavaScript heap the evaluation takes at its peak beyond its input (bytes): temporary
   * structures and the result. 0 when the modifier is not estimated (unknown type, invalid
   * parameters, or a result over the modifier's own limit, which it refuses by itself).
   */
  bytes: number;
  /** What to lower for a smaller result (for messages), e.g. "levels (render_levels for renders)". */
  lower: string;
}

export interface EstimateContext {
  /** Render settings (SUBSURF render_levels, SCREW render_steps) instead of the viewport's. */
  forRender: boolean;
  /** Faces of another object's evaluated mesh (Boolean operands), when known. */
  operandFaces?: (objectId: string) => number | null;
}

/** Peak heap per face of the result (bytes), for modifiers that grow the mesh. */
export const MODIFIER_BYTES_PER_RESULT_FACE = {
  /** 583–675 measured (4,000,000 faces from a 125×125 grid at levels 4: 2.4 GB). */
  SUBSURF: 700,
  /** 347 measured. */
  ARRAY: 400,
  /** With use_mirror_merge (the default): 1069 measured on one axis, 1481 per estimated face on three. */
  MIRROR: 1500,
  /** Without merging: 412 measured. */
  MIRROR_NO_MERGE: 450,
  /** 998 measured. */
  SOLIDIFY: 1100,
  /** 555 measured (three faces per corner of the input). */
  WIREFRAME: 600,
  /** 490 measured. */
  TRIANGULATE: 550,
  /** Faces added by Bevel: 1670 measured (limit_method NONE, 2 segments). */
  BEVEL_ADDED: 1700,
  /** Faces swept by Screw (estimated from the profile's vertices). */
  SCREW: 700,
  /** Boolean: faces of both operands. */
  BOOLEAN: 4000,
} as const;

/** Peak heap per face of the input (bytes): every modifier copies its input, most build its topology. */
export const MODIFIER_BYTES_PER_INPUT_FACE: Readonly<Record<string, number>> = {
  /** 2.7 KB measured (topology and edge angles, nothing beveled on a flat grid). */
  BEVEL: 2800,
  /** 2.1 KB measured (a grid as the profile). */
  SCREW: 2200,
  /** COLLAPSE: more than 6.1 KB (still running after 10 minutes on 250,000 faces). */
  DECIMATE: 6500,
  /** 2.56 KB measured. */
  EDGE_SPLIT: 2600,
  /** 1.53 and 1.50 KB measured. */
  SMOOTH: 1600,
  SMOOTH_BY_ANGLE: 1600,
  /** 672 measured. */
  WELD: 700,
  /** 274–355 measured. */
  DISPLACE: 400,
  CAST: 400,
  SIMPLE_DEFORM: 400,
  WAVE: 400,
  /** Not measured: deforms that read weights or another object. */
  ARMATURE: 600,
  CURVE: 600,
  SHRINKWRAP: 600,
  /** 197 measured. */
  BUILD: 200,
};

/** Subdivision Surface refuses results over this many faces itself (subsurf.ts). */
const SUBSURF_MAX_FACES = 4_000_000;
/** Array refuses results over this many vertices itself (array.ts). */
const ARRAY_MAX_VERTICES = 5_000_000;

const same = (s: MeshSize): MeshSize => ({ faces: s.faces, corners: s.corners, vertices: s.vertices });
const elements = (s: MeshSize): number => Math.max(s.faces, s.vertices);
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/**
 * The estimated result size of modifier `mod` evaluated on a mesh of size `input`, and the peak
 * JavaScript heap of that evaluation (see the module comment). Modifiers are estimated with the
 * parameters they will run with (schema defaults filled in).
 */
export function estimateModifier(mod: ModifierData, input: MeshSize, ctx: EstimateContext): ModifierEstimate {
  registerBuiltinModifiers();
  const def = getModifierDef(mod.type);
  const parsed = def?.schema.safeParse(mod.params ?? {});
  if (!parsed?.success) return { result: same(input), bytes: 0, lower: '' };
  return estimateParsed(mod.type, parsed.data as Record<string, unknown>, input, ctx);
}

/** {@link estimateModifier} with parameters already validated by the modifier's schema. */
function estimateParsed(
  type: string,
  p: Record<string, unknown>,
  input: MeshSize,
  ctx: EstimateContext,
): ModifierEstimate {
  const none: ModifierEstimate = { result: same(input), bytes: 0, lower: '' };
  const F = input.faces;
  const C = input.corners;
  const V = input.vertices;
  const perInput = (MODIFIER_BYTES_PER_INPUT_FACE[type] ?? 0) * Math.max(F, V);
  const K = MODIFIER_BYTES_PER_RESULT_FACE;
  switch (type) {
    case 'SUBSURF': {
      const levels = Math.round(num(ctx.forRender ? p.render_levels : p.levels, 0));
      if (levels <= 0 || V === 0) return none;
      const faces = C * 4 ** (levels - 1);
      if (faces > SUBSURF_MAX_FACES) return none;
      const result = { faces, corners: 4 * faces, vertices: faces + V };
      return {
        result,
        bytes: K.SUBSURF * Math.max(faces, V * 2 ** levels),
        lower: ctx.forRender ? 'render_levels' : 'levels (render_levels for renders)',
      };
    }
    case 'ARRAY': {
      let count = Math.round(num(p.count, 2));
      if (p.fit_type === 'FIT_LENGTH') {
        const fit = num(p.fit_length, 0);
        const rel = (p.relative_offset_displace as number[] | undefined) ?? [1, 0, 0];
        const cst = (p.constant_offset_displace as number[] | undefined) ?? [1, 0, 0];
        if (p.use_object_offset || !input.extent) count = 10_000;
        else {
          const step = [0, 1, 2].map(
            (k) =>
              (p.use_relative_offset !== false ? rel[k] * input.extent![k] : 0) +
              (p.use_constant_offset ? cst[k] : 0),
          );
          const dist = Math.hypot(step[0], step[1], step[2]);
          count = dist > 1e-9 ? Math.floor(fit / dist + 1e-6) + 1 : 1;
        }
        count = Math.max(1, Math.min(10_000, count, Math.floor(ARRAY_MAX_VERTICES / Math.max(1, V))));
      }
      if (V === 0 || count * V > ARRAY_MAX_VERTICES) return none;
      const result = { faces: F * count, corners: C * count, vertices: V * count };
      return { result, bytes: K.ARRAY * elements(result), lower: 'count' };
    }
    case 'MIRROR': {
      const axes = Array.isArray(p.use_axis) ? p.use_axis.filter(Boolean).length : 0;
      if (!axes || V === 0) return none;
      const n = 2 ** axes;
      const result = { faces: F * n, corners: C * n, vertices: V * n };
      const per = p.use_mirror_merge === false ? K.MIRROR_NO_MERGE : K.MIRROR;
      return { result, bytes: per * elements(result), lower: 'the mirror axes' };
    }
    case 'SCREW': {
      const steps = Math.round(num(ctx.forRender ? p.render_steps : p.steps, 16));
      const iterations = Math.round(num(p.iterations, 1));
      if (V === 0 || (num(p.angle, 1) === 0 && num(p.screw_offset, 0) === 0)) return none;
      const swept = V * steps * iterations;
      const result = { faces: swept, corners: 4 * swept, vertices: swept };
      return {
        result,
        bytes: perInput + K.SCREW * swept,
        lower: ctx.forRender
          ? 'render_steps or iterations'
          : 'steps (render_steps for renders) or iterations',
      };
    }
    case 'SOLIDIFY': {
      const rimOnly = !!p.use_rim_only;
      const result = rimOnly ? same(input) : { faces: 2 * F, corners: 2 * C, vertices: 2 * V };
      return { result, bytes: K.SOLIDIFY * Math.max(2 * F, V), lower: 'the faces of the mesh' };
    }
    case 'WIREFRAME': {
      const faces = 3 * C;
      const result = { faces, corners: 4 * faces, vertices: 2 * C };
      return { result, bytes: K.WIREFRAME * Math.max(faces, V), lower: 'the faces of the mesh' };
    }
    case 'TRIANGULATE': {
      const faces = Math.max(F, C - 2 * F);
      const result = { faces, corners: 3 * faces, vertices: V };
      return { result, bytes: K.TRIANGULATE * Math.max(faces, V), lower: 'the faces of the mesh' };
    }
    case 'BEVEL': {
      const s = Math.max(1, Math.round(num(p.segments, 1)));
      // limit_method NONE bevels every edge (about corners / 2) and every vertex; ANGLE only sharp
      // edges, which the estimate cannot know: their faces are not counted
      const added = p.limit_method === 'NONE' ? Math.round((C / 2) * s + V * s * s) : 0;
      const result = { faces: F + added, corners: C + 4 * added, vertices: V + added };
      return { result, bytes: perInput + K.BEVEL_ADDED * added, lower: 'segments' };
    }
    case 'BOOLEAN': {
      const other = typeof p.object === 'string' ? (ctx.operandFaces?.(p.object) ?? 0) : 0;
      if (!p.object) return none;
      const result = { faces: F + other, corners: C + 4 * other, vertices: V + other };
      return { result, bytes: K.BOOLEAN * (F + other), lower: 'the faces of both meshes' };
    }
    default:
      return { result: same(input), bytes: perInput, lower: 'the faces of the mesh' };
  }
}

/** What a {@link GeometryMemoryCheck} is asked before a modifier runs. */
export interface GeometryMemoryRequest {
  /** Modifier type, e.g. "SUBSURF". */
  type: string;
  /** Modifier type label, e.g. "Subdivision Surface". */
  label: string;
  estimate: ModifierEstimate;
}

/** Returns null to run the modifier, or why it is skipped (it then fails with that message). */
export type GeometryMemoryCheck = (req: GeometryMemoryRequest) => string | null;

let installed: GeometryMemoryCheck | null = null;
let refusals = 0;
/** The registered modifiers as they were before they were wrapped, by type. */
const unwrapped = new Map<string, ModifierDef>();

/** `def` with the installed check before it runs (see the module comment). */
function guarded(def: ModifierDef): ModifierDef {
  return {
    ...def,
    apply(mesh, params, ctx) {
      const check = installed;
      if (check) {
        const estimate = estimateParsed(
          def.type,
          params as Record<string, unknown>,
          meshSize(mesh, def.type === 'ARRAY'),
          {
            forRender: ctx.forRender,
            operandFaces: (id) => ctx.getObjectMesh(id)?.mesh.faces.length ?? null,
          },
        );
        const reason = estimate.bytes > 0 ? check({ type: def.type, label: def.label, estimate }) : null;
        if (reason) {
          refusals++;
          throw new Error(reason);
        }
      }
      return def.apply(mesh, params, ctx);
    },
  };
}

/**
 * Installs the check every modifier runs before it (null removes it and restores the modifiers).
 * Returns the check that was installed before.
 */
export function setGeometryMemoryCheck(check: GeometryMemoryCheck | null): GeometryMemoryCheck | null {
  const before = installed;
  installed = check;
  registerBuiltinModifiers();
  if (check) {
    for (const def of listModifierDefs()) {
      if (unwrapped.has(def.type)) continue;
      unwrapped.set(def.type, def);
      registerModifier(guarded(def));
    }
  } else {
    for (const def of unwrapped.values()) registerModifier(def);
    unwrapped.clear();
  }
  return before;
}

/** The installed check, if any. */
export function geometryMemoryCheck(): GeometryMemoryCheck | null {
  return installed;
}

/** Modifiers the installed checks refused so far (a result with one of them is not cached). */
export function geometryMemoryRefusals(): number {
  return refusals;
}
