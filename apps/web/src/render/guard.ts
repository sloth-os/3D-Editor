import {
  listModifierDefs,
  meshSize,
  registerBuiltinModifiers,
  registerModifier,
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
  bevelHeap,
  modifierEstimate,
  planRenderThreads,
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
 */

/** The parameters of core's Bevel modifier that decide its size (as its schema fills them in). */
export interface BevelSizeParams {
  width: number;
  segments: number;
  limit_method: string;
  angle_limit: number;
  affect: string;
}

/**
 * The size of what core's Bevel modifier makes of `mesh`, and the heap it takes, counted from the
 * edges and corners it bevels without beveling them: an edge between two faces (limit_method NONE,
 * or ANGLE when its faces meet at more than angle_limit) gets a strip of `segments` faces; a corner
 * where such edges meet gets a patch (three or more edges and two or more segments: a quad grid of
 * ⌊segments / 2⌋ × ⌈segments / 2⌉ faces per edge, one more in the middle when the segments are odd;
 * else one polygon). With affect VERTICES every corner with such an edge gets the patch of its faces.
 * An upper bound: core bevels only edges whose ends have a closed fan of faces, and merges or welds
 * some patches. The heap: as Chrome takes it per input face or vertex, per edge and corner it
 * bevels and per face it adds ({@link bevelHeap}).
 */
export function bevelEstimate(mesh: MeshData, p: BevelSizeParams): ModifierEstimate {
  const faces = mesh.faces;
  const F = faces.length;
  const V = Math.floor(mesh.positions.length / 3);
  let C = 0;
  for (const f of faces) C += f.length;
  const input: MeshSize = { faces: F, corners: C, vertices: V };
  if (!(p.width > 0) || F === 0) return { result: input, bytes: 0, lower: 'segments' };
  const S = Math.max(1, Math.round(p.segments));
  const angle = p.limit_method !== 'NONE';
  // the corners of each vertex: their face and their place in it
  const start = new Int32Array(V + 1);
  for (const f of faces) for (const v of f) if (v >= 0 && v < V) start[v + 1]++;
  for (let v = 0; v < V; v++) start[v + 1] += start[v];
  const next = start.slice(0, V);
  const cornerFace = new Int32Array(C);
  const cornerAt = new Int32Array(C);
  for (let f = 0; f < F; f++) {
    const face = faces[f];
    for (let i = 0; i < face.length; i++) {
      const v = face[i];
      if (v < 0 || v >= V) continue;
      const k = next[v]++;
      cornerFace[k] = f;
      cornerAt[k] = i;
    }
  }
  // unit face normals (Newell, as core's Bevel computes them; zero for degenerate faces)
  const normals = angle ? new Float64Array(3 * F) : null;
  if (normals) {
    const P = mesh.positions;
    for (let f = 0; f < F; f++) {
      const face = faces[f];
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let i = 0; i < face.length; i++) {
        const a = face[i] * 3;
        const b = face[(i + 1) % face.length] * 3;
        nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
        ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
        nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
      }
      const l = Math.hypot(nx, ny, nz);
      if (l > 1e-30) {
        normals[f * 3] = nx / l;
        normals[f * 3 + 1] = ny / l;
        normals[f * 3 + 2] = nz / l;
      }
    }
  }
  const cosLimit = Math.cos(p.angle_limit);
  /** The faces of edge (a, b) of face f: how many, the first (lowest index), another one. */
  const edgeFaces = (f: number, a: number, b: number) => {
    let users = 0;
    let first = f;
    let other = -1;
    for (let c = start[a]; c < start[a + 1]; c++) {
      const g = cornerFace[c];
      const gf = faces[g];
      const j = cornerAt[c];
      if (gf[(j + 1) % gf.length] !== b && gf[(j + gf.length - 1) % gf.length] !== b) continue;
      users++;
      if (g < first) first = g;
      if (g !== f) other = g;
    }
    return { users, first, other };
  };
  // core bevels only around vertices with a closed fan of faces: not at an edge with one face or
  // more than two (open borders, non-manifold parts)
  const fan = new Uint8Array(V).fill(1);
  for (let f = 0; f < F; f++) {
    const face = faces[f];
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      if (a < 0 || a >= V || b < 0 || b >= V) continue;
      if (a === b || edgeFaces(f, a, b).users !== 2) fan[a] = fan[b] = 0;
    }
  }
  // beveled edges per vertex; each edge is counted from the first face that has it
  const beveled = new Int32Array(V);
  let edges = 0;
  for (let f = 0; f < F; f++) {
    const face = faces[f];
    const L = face.length;
    for (let i = 0; i < L; i++) {
      const a = face[i];
      const b = face[(i + 1) % L];
      if (a === b || a < 0 || a >= V || b < 0 || b >= V || !fan[a] || !fan[b]) continue;
      const { users, first, other } = edgeFaces(f, a, b);
      if (users !== 2 || first !== f) continue;
      if (normals && other >= 0) {
        const dot =
          normals[f * 3] * normals[other * 3] +
          normals[f * 3 + 1] * normals[other * 3 + 1] +
          normals[f * 3 + 2] * normals[other * 3 + 2];
        // core: sharper than the limit (minus 1e-9); counted generously here
        if (!(dot < cosLimit + 1e-9)) continue;
      }
      edges++;
      beveled[a]++;
      beveled[b]++;
    }
  }
  const half = Math.floor(S / 2);
  const odd = S % 2;
  let added = 0;
  // corners of the new faces, and the corners the faces around beveled corners gain
  let corners = 0;
  let selected = 0;
  /**
   * The patch where n profiles meet at a vertex: a quad grid, else one polygon of `polygon` corners
   * (the profiles' points, and the points on the edges between them).
   */
  const patch = (n: number, polygon: number) => {
    if (n >= 3 && S >= 2) {
      const quads = n * half * (half + odd);
      added += quads + odd;
      corners += 4 * quads + odd * n;
    } else {
      added++;
      corners += polygon;
    }
  };
  // vertices that get a patch
  let patched = 0;
  if (p.affect === 'VERTICES') {
    for (let v = 0; v < V; v++) {
      const valence = start[v + 1] - start[v];
      if (!valence || !fan[v] || (angle && !beveled[v])) continue;
      patch(valence, S * valence);
      patched++;
      // each corner of the vertex becomes an arc of S + 1 points in its face
      corners += S * valence;
      selected += valence;
    }
  } else if (edges) {
    added += S * edges;
    corners += 4 * S * edges;
    for (let v = 0; v < V; v++) {
      const k = beveled[v];
      if (!k) continue;
      const valence = start[v + 1] - start[v];
      patch(k, S * k + 2 * (valence - k));
      patched++;
      // the edges next to a beveled one get a slide point, in the loops of both their faces
      corners += 2 * Math.min(2 * k, valence - k);
    }
  }
  if (!added) return { result: input, bytes: bevelHeap(input, 0, 0), lower: 'segments' };
  return {
    result: { faces: F + added, corners: C + corners, vertices: V + C + added + S * selected },
    bytes: bevelHeap(input, added, (p.affect === 'VERTICES' ? 0 : edges) + patched),
    lower: 'segments',
  };
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

/** Triangles of a mesh (a face of n corners makes n − 2). */
function meshTriangles(m: MeshData): number {
  let n = 0;
  for (const f of m.faces) n += Math.max(0, f.length - 2);
  return n;
}

/** `def` checked by `guard` before it runs (see {@link guardedEvaluation}). */
function guardedModifier(
  def: ModifierDef,
  guard: EvaluationGuard,
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
export function guardedEvaluation<T>(guard: EvaluationGuard, evaluate: () => T): T {
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
  const lower = refusal.lower.startsWith('the ') ? refusal.lower : `its ${refusal.lower}`;
  const name = where
    ? `the ${refusal.label} modifier '${where.modifier}' of '${where.object}'`
    : `a ${refusal.label} modifier`;
  return (
    planRenderThreads({ ...refusal.needs, cause: { name, lower, triangles: refusal.triangles } }, 1, memory)
      .refusal ?? refusal.message
  );
}
