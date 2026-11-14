import type { ObjectData } from '../doc/types';
import { decodedMeshBytes } from '../mesh/memory';
import type { OperatorContext } from './context';
import type { KeyframeWrites } from './memory-keyframes';
import type { LayerKind } from './memory-layers';
import { newObjectsBytes, saveBytes, type CountedKind, type NewObjects } from './memory-objects';

/*
 * What every estimate module shares (operators/memory.ts and the modules whose estimate tables it
 * spreads, such as memory-desk.ts): the estimate type, the young generation's garbage every
 * estimate includes, and the helpers that count new objects and keyframes. It imports nothing of
 * memory.ts, so that memory.ts can import the modules that use it without an import cycle.
 */

/** The estimated memory of one operator run. */
export interface OperatorEstimate {
  /**
   * JavaScript heap the run takes at its peak beyond what is in use before it (bytes), the decoded
   * size of the geometry it stores included.
   */
  bytes: number;
  /** Faces of the mesh(es) it builds or edits, for messages (0: none). */
  faces: number;
  /**
   * Heap the document keeps of what it adds (0 when it adds nothing): the decoded size of the
   * meshes it adds, and its new objects and datablocks (memory-objects.ts).
   */
  addedStoredBytes: number;
  /**
   * Heap a save of the project takes for a moment for what it adds, beyond addedStoredBytes
   * (memory-objects.ts saveBytes of its new objects, datablocks and keyframes; 0 or absent: none).
   */
  addedSaveBytes?: number;
  /** Objects it adds (for messages; 0 or absent: none). */
  objects?: number;
  /** Keyframes it adds at most (for messages; 0 or absent: none). */
  keyframes?: number;
  /**
   * Bytes of rigid body frames it simulates that the document's cache keeps afterwards (physics/
   * memory.ts; part of addedStoredBytes, not saved; 0 or absent: none).
   */
  simulationBytes?: number;
  /** Meshes it builds when more than one (an import; for messages, with `faces` their faces in all). */
  meshes?: number;
  /**
   * The vertex groups or shape keys of meshes it writes (memory-layers.ts; for messages: their kind and
   * bytes, the more of before and after); absent: none.
   */
  layers?: { kind: LayerKind; bytes: number };
  /**
   * What to lower for a smaller result, completing "Lower …" (e.g. "number_cuts"); empty when the
   * operator adds next to nothing (a cube).
   */
  lower: string;
}

/** The estimate of one operator from its parameters (schema defaults filled in); null: none. */
export type Estimator = (ctx: OperatorContext, params: Record<string, unknown>) => OperatorEstimate | null;

/**
 * Garbage an operator's run leaves in V8's young generation before a scavenge collects it, part of
 * every peak measured with --trace-gc (bytes): what small runs show beyond their per-face cost.
 * Every estimate includes it.
 */
export const OPERATOR_FIXED_BYTES = 32 * 1024 * 1024;

/** Decoded bytes of a mesh of `faces` faces of `cornersPerFace` corners with UVs (vertices ≈ faces). */
export function decodedFaces(faces: number, cornersPerFace = 4): number {
  return decodedMeshBytes({
    vertices: faces,
    faces,
    corners: faces * cornersPerFace,
    uvs: true,
    colors: false,
  });
}

/**
 * `e` with the objects and datablocks an operator adds (memory-objects.ts): their peak heap on top
 * of its own, and what the document keeps of them added to what it stores. An operator with no
 * estimate of its own gets the young generation's garbage (OPERATOR_FIXED_BYTES) and these, and
 * `lower` (also when `e` has nothing to lower).
 */
export function withObjects(e: OperatorEstimate | null, a: NewObjects, lower = ''): OperatorEstimate | null {
  const datablocks = Object.values(a.datablocks ?? {}).reduce((n, k) => n + (k ?? 0), 0);
  if (!(a.objects > 0) && !(datablocks > 0)) return e;
  const { peak, stored } = newObjectsBytes(a);
  return {
    ...e,
    bytes: (e?.bytes ?? OPERATOR_FIXED_BYTES) + peak,
    faces: e?.faces ?? 0,
    addedStoredBytes: (e?.addedStoredBytes ?? 0) + stored,
    addedSaveBytes: (e?.addedSaveBytes ?? 0) + saveBytes(stored),
    objects: (e?.objects ?? 0) + Math.max(0, a.objects),
    lower: e?.lower || lower,
  };
}

/** One new object (and its datablock of `kind`, if any): the add operators. */
export function oneObject(kind: CountedKind | null, lower = ''): Estimator {
  return () => withObjects(null, { objects: 1, datablocks: kind ? { [kind]: 1 } : {} }, lower);
}

/**
 * An operator that writes keyframes (memory-keyframes.ts); null when it fails by itself. The rigid body
 * frames a bake simulates count with what the project keeps (its cache holds them), not saved.
 */
export function keyframeEstimate(w: KeyframeWrites | null): OperatorEstimate | null {
  if (!w) return null;
  const simulation = w.simulation ?? 0;
  return {
    bytes: OPERATOR_FIXED_BYTES + w.bytes,
    faces: 0,
    addedStoredBytes: w.stored + simulation,
    addedSaveBytes: w.save,
    keyframes: w.keys,
    ...(simulation > 0 ? { simulationBytes: simulation } : {}),
    lower: w.lower,
  };
}

/**
 * The objects `refs` names (ids or names, each once; unknown ones left out: the operator reports
 * them itself), or the selected objects without any.
 */
export function refObjects(ctx: OperatorContext, refs: unknown): ObjectData[] {
  const list = Array.isArray(refs) && refs.length ? refs.map(String) : ctx.state.selectedIds;
  const seen = new Set<string>();
  const out: ObjectData[] = [];
  for (const r of list) {
    const o = ctx.doc.getObject(r) ?? ctx.doc.resolveObject(r);
    if (!o || seen.has(o.id)) continue;
    seen.add(o.id);
    out.push(o);
  }
  return out;
}
