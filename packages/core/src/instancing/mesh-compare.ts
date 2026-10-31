import type { MeshData } from '../mesh/types';

/*
 * Content comparison of (immutable) meshes for the instancing caches. Every evaluator keeps its own
 * modifier results, so the viewport and one-shot evaluations (operator reports, exports, renders,
 * MCP queries) hand out distinct MeshData objects for identical geometry. Cached distributions and
 * placements are therefore validated by content: identity is the fast path, an element-wise
 * comparison (early exit on the first difference, memoized per mesh pair) the fallback. Meshes
 * must not be mutated once evaluated (see MeshData).
 */

type Compare = (a: MeshData, b: MeshData) => boolean;

/** Memoized results per mesh pair (weak on both meshes). */
function memoized(memo: WeakMap<MeshData, WeakMap<MeshData, boolean>>, compare: Compare): Compare {
  return (a, b) => {
    if (a === b) return true;
    let inner = memo.get(a);
    if (!inner) memo.set(a, (inner = new WeakMap()));
    let r = inner.get(b);
    if (r === undefined) {
      r = compare(a, b);
      inner.set(b, r);
    }
    return r;
  };
}

function sameValues<T>(a: ArrayLike<T> | null | undefined, b: ArrayLike<T> | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameNested(a: readonly (readonly number[])[] | null, b: readonly (readonly number[])[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameValues(a[i], b[i])) return false;
  return true;
}

/** Same vertex count and identical face loops (deformations keep the topology). */
export const sameTopology: Compare = memoized(
  new WeakMap(),
  (a, b) => a.positions.length === b.positions.length && sameNested(a.faces, b.faces),
);

/** Same topology and identical vertex positions: everything a particle distribution reads. */
export const sameGeometry: Compare = memoized(
  new WeakMap(),
  (a, b) => sameTopology(a, b) && sameValues(a.positions, b.positions),
);

/** Same geometry, smooth flags and UVs: everything the particle placement reads. */
export const sameSurface: Compare = memoized(
  new WeakMap(),
  (a, b) => sameGeometry(a, b) && sameValues(a.faceSmooth, b.faceSmooth) && sameNested(a.uvs, b.uvs),
);
