import {
  bevelCount,
  listModifierDefs,
  meshSize,
  registerBuiltinModifiers,
  registerModifier,
  type BevelSizeParams,
  type MeshData,
  type MeshSize,
  type ModifierData,
  type ModifierDef,
  type ModifierEstimate,
} from '@3d-editor/core';
import {
  COMPILED_BYTES_PER_TRIANGLE,
  INSTANCE_BYTES,
  PREPARE_BYTES_PER_TRIANGLE,
  RASTER_BYTES_PER_TRIANGLE,
  bevelHeap,
  modifierEstimate,
  planRenderThreads,
  rasterRefusal,
  type RasterNeeds,
  type RenderEstimate,
  type RenderNeeds,
  type TabMemory,
} from './memory';

/*
 * The check of the first render worker's evaluation (see memory.ts). The estimate before any worker
 * starts sizes each modifier from the size of its input (core `estimateModifier`), but it cannot see
 * everything: which edges a Bevel limited by angle bevels depends on the shape of its input (core
 * counts none of them), and every modifier after it then gets a larger input than estimated. One
 * such Bevel made millions of triangles in the worker's heap and ended the tab (V8's out-of-memory
 * crash) before the check after the evaluation could refuse the render.
 *
 * So while the first worker evaluates the scene, every modifier is checked right before it runs,
 * from its real input: core's estimate of its peak heap and result (a Bevel's from the edges and
 * corners it really bevels, {@link bevelEstimate}), next to what the evaluation holds so far. One
 * that would not fit one render thread is not run: the evaluation stops building geometry, and the
 * worker refuses the render with the reason (`RenderWorkerEngine.prepare`).
 *
 * A RASTER render (F12, Render Animation and agents' renders with the WebGL rasterizer) evaluates
 * the scene on the page itself, at its render settings: its evaluation is checked the same way
 * ({@link RasterEvaluationGuard}), against what the page's heap holds and has left.
 */

/** The parameters of core's Bevel modifier that decide its size (as its schema fills them in). */
export type { BevelSizeParams } from '@3d-editor/core';

/**
 * The size of what core's Bevel modifier makes of `mesh`, and the heap it takes: the edges and
 * corners it bevels counted by core without beveling them (`bevelCount`: an edge between two faces,
 * by angle when its faces meet at more than angle_limit, gets a strip of `segments` faces; a corner
 * where such edges meet gets a patch; an upper bound), the heap as Chrome takes it per input face or
 * vertex, per edge and corner it bevels and per face it adds ({@link bevelHeap}).
 */
export function bevelEstimate(mesh: MeshData, p: BevelSizeParams): ModifierEstimate {
  const c = bevelCount(mesh, p);
  const input = meshSize(mesh);
  if (!c.runs) return { result: input, bytes: 0, lower: 'segments' };
  if (!c.added) return { result: input, bytes: bevelHeap(input, 0, 0), lower: 'segments' };
  return { result: c.result, bytes: bevelHeap(input, c.added, c.edges + c.patched), lower: 'segments' };
}

const trianglesOf = (s: MeshSize): number => Math.max(0, s.corners - 2 * s.faces);

/** What the guard says when it refuses a modifier: the render's refusal, and the modifier. */
export interface GuardRefusal {
  /** The reason, for the user and for agents ({@link planRenderThreads}' refusal). */
  message: string;
  /** The needs it was refused with (to say it again with the modifier's name). */
  needs: RenderNeeds;
  /** The modifier type and label, and what to lower (core's `lower`). */
  type: string;
  label: string;
  lower: string;
  /** Triangles the modifier would have made. */
  triangles: number;
}

/** What a modifier refused after the first refusal fails with (only the first one names the reason). */
export const SKIPPED_AFTER_REFUSAL = 'not evaluated: the render was refused';

/**
 * The check of one evaluation on the first render worker: built from the estimate of the scene
 * before the render started (`estimateRender` of its document) and the tab's memory. Modifiers
 * report to it before and after they run ({@link guardedEvaluation}); it keeps the triangles the
 * evaluation holds: the geometry it does not build (the estimate's `storedTriangles`) and the last
 * result of each modifier stack, at least what the estimate says the whole scene holds (results the
 * evaluator kept from an earlier render are not built again).
 */
export class EvaluationGuard {
  /** The first refusal, null while everything fit. */
  refusal: GuardRefusal | null = null;
  /** Triangles of the last result of each modifier stack evaluated so far. */
  private results = 0;

  constructor(
    private readonly estimate: RenderEstimate,
    private readonly pixels: number,
    private readonly memory: TabMemory,
  ) {}

  /** Triangles the evaluation holds now (see the class comment). */
  get heldTriangles(): number {
    return Math.max(this.estimate.evaluatedTriangles, this.estimate.storedTriangles + this.results);
  }

  /**
   * Whether a modifier of `def` may run: null, or the reason it may not (the refusal, or
   * {@link SKIPPED_AFTER_REFUSAL} after it). `replaces`: triangles of the stack's result it replaces
   * (its input, when the input is the result of the modifier before it).
   */
  before(
    def: Pick<ModifierDef, 'type' | 'label'>,
    estimate: ModifierEstimate,
    replaces: number,
  ): string | null {
    if (this.refusal) return SKIPPED_AFTER_REFUSAL;
    const e = this.estimate;
    const made = trianglesOf(estimate.result);
    // what the scene holds beyond the estimate once the modifier ran: compiled, as far as anyone knows
    const grown = Math.max(0, e.storedTriangles + this.results - replaces + made - e.evaluatedTriangles);
    const triangles = e.triangles + grown;
    const held = this.heldTriangles;
    // the heap while it runs: what the evaluation holds (its input included) and the modifier's peak
    // above its input (its result included); `renderMemory` counts the heap of the larger of the
    // compiled and the held triangles (its result among them), so only the rest of the peak on top
    const perTriangle = PREPARE_BYTES_PER_TRIANGLE.heap;
    const peak = held * perTriangle + estimate.bytes;
    const needs: RenderNeeds = {
      triangles,
      evaluatedTriangles: held,
      instances: e.instances,
      sceneBytes: triangles * COMPILED_BYTES_PER_TRIANGLE + e.instances * INSTANCE_BYTES.scene + e.imageBytes,
      pixels: this.pixels,
      evaluationHeap: Math.max(0, peak - Math.max(triangles, held) * perTriangle),
      // a RASTER render runs this modifier on the page: the refusal suggests it where that fits
      rasterFits: !rasterRefusal(rasterNeedsAt(e, this.results, estimate, replaces), this.memory),
    };
    const plan = planRenderThreads(needs, 1, this.memory);
    if (!plan.refusal) return null;
    this.refusal = {
      message: plan.refusal,
      needs,
      type: def.type,
      label: def.label,
      lower: estimate.lower,
      triangles: made,
    };
    return plan.refusal;
  }

  /** A modifier ran: its result (`made` triangles) replaces `replaces` triangles of its stack's result. */
  after(replaces: number, made: number): void {
    this.results += made - replaces;
  }
}

/**
 * What a RASTER render adds to the page's heap while the modifier of `estimate` runs (see
 * `rasterNeeds`): the geometry the evaluation builds, at least what the estimate of the scene says
 * (`results`: triangles of the modifier results evaluated so far), and the modifier's peak above its
 * input (its result included).
 */
function rasterNeedsAt(
  e: RenderEstimate,
  results: number,
  estimate: ModifierEstimate,
  replaces: number,
): RasterNeeds {
  const held = Math.max(e.builtTriangles, e.builtBaseTriangles + results);
  return {
    triangles: Math.max(held, e.builtBaseTriangles + results - replaces + trianglesOf(estimate.result)),
    heap: held * RASTER_BYTES_PER_TRIANGLE + e.instances * INSTANCE_BYTES.heap + estimate.bytes,
    instances: e.instances,
  };
}

/** What the check of a RASTER render's evaluation says when it refuses a modifier. */
export interface RasterGuardRefusal extends Omit<GuardRefusal, 'needs'> {
  /** The needs it was refused with (to say it again with the modifier's name). */
  needs: RasterNeeds;
}

/**
 * The check of a RASTER render's evaluation on the page (F12, Render Animation and agents' renders
 * with the WebGL rasterizer): like {@link EvaluationGuard}, every modifier is checked right before it
 * runs, from its real input, against what the evaluation adds to the page's heap (`rasterNeeds`) and
 * the room the tab's heap has (`memory`: the page's own heap and what the path traced renders running
 * in it hold).
 */
export class RasterEvaluationGuard implements ModifierGuard {
  /** The first refusal, null while everything fit. */
  refusal: RasterGuardRefusal | null = null;
  /** Triangles of the last result of each modifier stack evaluated so far. */
  private results = 0;

  constructor(
    private readonly estimate: RenderEstimate,
    private readonly memory: TabMemory,
  ) {}

  /** Triangles of the geometry the evaluation holds now: what it built so far, at least the estimate. */
  get heldTriangles(): number {
    return Math.max(this.estimate.builtTriangles, this.estimate.builtBaseTriangles + this.results);
  }

  /** Whether a modifier of `def` may run: null, or the reason it may not (see {@link EvaluationGuard.before}). */
  before(
    def: Pick<ModifierDef, 'type' | 'label'>,
    estimate: ModifierEstimate,
    replaces: number,
  ): string | null {
    if (this.refusal) return SKIPPED_AFTER_REFUSAL;
    const needs = rasterNeedsAt(this.estimate, this.results, estimate, replaces);
    const refusal = rasterRefusal(needs, this.memory);
    if (!refusal) return null;
    this.refusal = {
      message: refusal,
      needs,
      type: def.type,
      label: def.label,
      lower: estimate.lower,
      triangles: trianglesOf(estimate.result),
    };
    return refusal;
  }

  /** A modifier ran: its result (`made` triangles) replaces `replaces` triangles of its stack's result. */
  after(replaces: number, made: number): void {
    this.results += made - replaces;
  }
}

/** A check of every modifier of an evaluation ({@link guardedEvaluation}). */
export interface ModifierGuard {
  before(
    def: Pick<ModifierDef, 'type' | 'label'>,
    estimate: ModifierEstimate,
    replaces: number,
  ): string | null;
  after(replaces: number, made: number): void;
}

/** Triangles of a mesh (a face of n corners makes n − 2). */
function meshTriangles(m: MeshData): number {
  let n = 0;
  for (const f of m.faces) n += Math.max(0, f.length - 2);
  return n;
}

/** `def` checked by `guard` before it runs (see {@link guardedEvaluation}). */
function guardedModifier(
  def: ModifierDef,
  guard: ModifierGuard,
  last: { mesh: MeshData | null; triangles: number },
): ModifierDef {
  return {
    ...def,
    apply(mesh, params, ctx) {
      // the input is the result of the modifier before it (same stack): this one replaces it (asked
      // before a Boolean's operand is evaluated, whose stack is checked in between)
      const replaces = last.mesh === mesh ? last.triangles : 0;
      const estimate =
        def.type === 'BEVEL'
          ? bevelEstimate(mesh, params as unknown as BevelSizeParams)
          : modifierEstimate(
              { type: def.type, params } as unknown as ModifierData,
              meshSize(mesh, def.type === 'ARRAY'),
              {
                forRender: ctx.forRender,
                operandFaces: (id) => ctx.getObjectMesh(id)?.mesh.faces.length ?? null,
              },
            );
      const reason = guard.before(def, estimate, replaces);
      if (reason) throw new Error(reason);
      const result = def.apply(mesh, params, ctx);
      const made = meshTriangles(result);
      guard.after(replaces, made);
      last.mesh = result;
      last.triangles = made;
      return result;
    },
  };
}

/**
 * Runs `evaluate` (a synchronous evaluation of the scene) with every modifier checked by `guard`
 * before it runs; the modifiers are as they were afterwards. A refused modifier fails with the
 * reason (core's evaluator skips it and records the error); the evaluator must then not be used for
 * another render, as it may have kept results without that modifier.
 */
export function guardedEvaluation<T>(guard: ModifierGuard, evaluate: () => T): T {
  registerBuiltinModifiers();
  const defs = listModifierDefs();
  const last = { mesh: null as MeshData | null, triangles: 0 };
  for (const def of defs) registerModifier(guardedModifier(def, guard, last));
  try {
    return evaluate();
  } finally {
    for (const def of defs) registerModifier(def);
  }
}

/** The modifier a guarded evaluation refused, for its refusal: its name and its object's, what to lower. */
function modifierCause(
  refusal: Pick<GuardRefusal, 'label' | 'lower' | 'triangles'>,
  where: { object: string; modifier: string } | null,
): NonNullable<RenderNeeds['cause']> {
  const lower = refusal.lower.startsWith('the ') ? refusal.lower : `its ${refusal.lower}`;
  const name = where
    ? `the ${refusal.label} modifier '${where.modifier}' of '${where.object}'`
    : `a ${refusal.label} modifier`;
  return { name, lower, triangles: refusal.triangles };
}

/**
 * The refusal of a guarded evaluation with the modifier that was refused: its type, its name and its
 * object's (from the evaluated scene's modifier errors), the triangles it would have made and what
 * to lower.
 */
export function refusalWithModifier(
  refusal: GuardRefusal,
  memory: TabMemory,
  where: { object: string; modifier: string } | null,
): string {
  return (
    planRenderThreads({ ...refusal.needs, cause: modifierCause(refusal, where) }, 1, memory).refusal ??
    refusal.message
  );
}

/** {@link refusalWithModifier} for the check of a RASTER render ({@link RasterEvaluationGuard}). */
export function rasterRefusalWithModifier(
  refusal: RasterGuardRefusal,
  memory: TabMemory,
  where: { object: string; modifier: string } | null,
): string {
  return rasterRefusal({ ...refusal.needs, cause: modifierCause(refusal, where) }, memory) ?? refusal.message;
}
