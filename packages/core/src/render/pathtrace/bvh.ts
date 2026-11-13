/*
 * Bounding volume hierarchy over axis-aligned boxes, built with the binned surface area heuristic.
 * Used both for the per-mesh triangle BVHs (BLAS) and for the top level over instances (TLAS).
 *
 * Layout (flat typed arrays, plain data so a BVH can be posted to a worker):
 * - `bounds[node * 6 + 0..5]` = min xyz, max xyz,
 * - interior node: `count = 0`, children at `child` and `child + 1`,
 * - leaf: `count > 0` primitives `prims[child .. child + count)`.
 * Node 0 is the root. An empty BVH has one empty leaf with inverted (empty) bounds.
 */

export interface BVH {
  nodeCount: number;
  /** Maximum depth (root = 0); traversal stacks need `depth + 1` entries. */
  depth: number;
  bounds: Float64Array;
  child: Int32Array;
  count: Int32Array;
  /** Primitive indices in leaf order. */
  prims: Uint32Array;
}

const BINS = 16;
const TRAVERSAL_COST = 1;
const INTERSECT_COST = 1.2;

function area(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  return dx < 0 || dy < 0 || dz < 0 ? 0 : 2 * (dx * dy + dy * dz + dz * dx);
}

/**
 * Builds a BVH over `n` boxes given as `boxes[i * 6 + 0..5]` (min xyz, max xyz). Boxes must be
 * finite. `maxLeaf` caps the primitives per leaf (except for primitives with identical centroids,
 * which are split by count).
 */
export function buildBVH(boxes: Float64Array, n: number, maxLeaf = 4): BVH {
  const prims = new Uint32Array(n);
  for (let i = 0; i < n; i++) prims[i] = i;
  const cap = Math.max(1, 2 * n - 1);
  const bounds = new Float64Array(cap * 6);
  const child = new Int32Array(cap);
  const count = new Int32Array(cap);
  if (n === 0) {
    bounds.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    return { nodeCount: 1, depth: 0, bounds, child, count, prims };
  }
  const cent = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    cent[i * 3] = (boxes[o] + boxes[o + 3]) * 0.5;
    cent[i * 3 + 1] = (boxes[o + 1] + boxes[o + 4]) * 0.5;
    cent[i * 3 + 2] = (boxes[o + 2] + boxes[o + 5]) * 0.5;
  }
  const binCount = new Int32Array(BINS);
  const binBox = new Float64Array(BINS * 6);
  const rightArea = new Float64Array(BINS);
  const rightCount = new Int32Array(BINS);
  const binOf = new Uint8Array(n);
  // explicit work stack: node, start, end, depth
  const stack: number[] = [0, 0, n, 0];
  let nodeCount = 1;
  let maxDepth = 0;
  while (stack.length) {
    const depth = stack.pop()!;
    const end = stack.pop()!;
    const start = stack.pop()!;
    const node = stack.pop()!;
    if (depth > maxDepth) maxDepth = depth;
    // node bounds and centroid bounds
    let bx0 = Infinity;
    let by0 = Infinity;
    let bz0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    let bz1 = -Infinity;
    let cx0 = Infinity;
    let cy0 = Infinity;
    let cz0 = Infinity;
    let cx1 = -Infinity;
    let cy1 = -Infinity;
    let cz1 = -Infinity;
    for (let i = start; i < end; i++) {
      const p = prims[i];
      const o = p * 6;
      if (boxes[o] < bx0) bx0 = boxes[o];
      if (boxes[o + 1] < by0) by0 = boxes[o + 1];
      if (boxes[o + 2] < bz0) bz0 = boxes[o + 2];
      if (boxes[o + 3] > bx1) bx1 = boxes[o + 3];
      if (boxes[o + 4] > by1) by1 = boxes[o + 4];
      if (boxes[o + 5] > bz1) bz1 = boxes[o + 5];
      const x = cent[p * 3];
      const y = cent[p * 3 + 1];
      const z = cent[p * 3 + 2];
      if (x < cx0) cx0 = x;
      if (y < cy0) cy0 = y;
      if (z < cz0) cz0 = z;
      if (x > cx1) cx1 = x;
      if (y > cy1) cy1 = y;
      if (z > cz1) cz1 = z;
    }
    const nb = node * 6;
    bounds[nb] = bx0;
    bounds[nb + 1] = by0;
    bounds[nb + 2] = bz0;
    bounds[nb + 3] = bx1;
    bounds[nb + 4] = by1;
    bounds[nb + 5] = bz1;
    const cnt = end - start;
    const makeLeaf = () => {
      child[node] = start;
      count[node] = cnt;
    };
    if (cnt <= 1) {
      makeLeaf();
      continue;
    }
    // best binned SAH split over the three axes
    const parentArea = area(bx0, by0, bz0, bx1, by1, bz1);
    let bestCost = Infinity;
    let bestAxis = -1;
    let bestSplit = 0;
    const cmin = [cx0, cy0, cz0];
    const cext = [cx1 - cx0, cy1 - cy0, cz1 - cz0];
    for (let axis = 0; axis < 3; axis++) {
      const ext = cext[axis];
      if (!(ext > 1e-12 * (Math.abs(cmin[axis]) + 1))) continue;
      const scale = BINS / ext;
      const c0 = cmin[axis];
      binCount.fill(0);
      for (let b = 0; b < BINS; b++) {
        const o = b * 6;
        binBox[o] = binBox[o + 1] = binBox[o + 2] = Infinity;
        binBox[o + 3] = binBox[o + 4] = binBox[o + 5] = -Infinity;
      }
      for (let i = start; i < end; i++) {
        const p = prims[i];
        let b = Math.floor((cent[p * 3 + axis] - c0) * scale);
        if (b >= BINS) b = BINS - 1;
        else if (b < 0) b = 0;
        binCount[b]++;
        const o = b * 6;
        const q = p * 6;
        if (boxes[q] < binBox[o]) binBox[o] = boxes[q];
        if (boxes[q + 1] < binBox[o + 1]) binBox[o + 1] = boxes[q + 1];
        if (boxes[q + 2] < binBox[o + 2]) binBox[o + 2] = boxes[q + 2];
        if (boxes[q + 3] > binBox[o + 3]) binBox[o + 3] = boxes[q + 3];
        if (boxes[q + 4] > binBox[o + 4]) binBox[o + 4] = boxes[q + 4];
        if (boxes[q + 5] > binBox[o + 5]) binBox[o + 5] = boxes[q + 5];
      }
      // sweep from the right: area and count of bins [b, BINS)
      let rx0 = Infinity;
      let ry0 = Infinity;
      let rz0 = Infinity;
      let rx1 = -Infinity;
      let ry1 = -Infinity;
      let rz1 = -Infinity;
      let rc = 0;
      for (let b = BINS - 1; b > 0; b--) {
        const o = b * 6;
        if (binCount[b]) {
          if (binBox[o] < rx0) rx0 = binBox[o];
          if (binBox[o + 1] < ry0) ry0 = binBox[o + 1];
          if (binBox[o + 2] < rz0) rz0 = binBox[o + 2];
          if (binBox[o + 3] > rx1) rx1 = binBox[o + 3];
          if (binBox[o + 4] > ry1) ry1 = binBox[o + 4];
          if (binBox[o + 5] > rz1) rz1 = binBox[o + 5];
        }
        rc += binCount[b];
        rightCount[b] = rc;
        rightArea[b] = area(rx0, ry0, rz0, rx1, ry1, rz1);
      }
      // sweep from the left, evaluating the split between bins b-1 and b
      let lx0 = Infinity;
      let ly0 = Infinity;
      let lz0 = Infinity;
      let lx1 = -Infinity;
      let ly1 = -Infinity;
      let lz1 = -Infinity;
      let lc = 0;
      for (let b = 1; b < BINS; b++) {
        const o = (b - 1) * 6;
        if (binCount[b - 1]) {
          if (binBox[o] < lx0) lx0 = binBox[o];
          if (binBox[o + 1] < ly0) ly0 = binBox[o + 1];
          if (binBox[o + 2] < lz0) lz0 = binBox[o + 2];
          if (binBox[o + 3] > lx1) lx1 = binBox[o + 3];
          if (binBox[o + 4] > ly1) ly1 = binBox[o + 4];
          if (binBox[o + 5] > lz1) lz1 = binBox[o + 5];
        }
        lc += binCount[b - 1];
        if (lc === 0 || rightCount[b] === 0) continue;
        const cost = area(lx0, ly0, lz0, lx1, ly1, lz1) * lc + rightArea[b] * rightCount[b];
        if (cost < bestCost) {
          bestCost = cost;
          bestAxis = axis;
          bestSplit = b;
        }
      }
    }
    const leafCost = INTERSECT_COST * cnt;
    const splitCost =
      bestAxis >= 0
        ? TRAVERSAL_COST + (parentArea > 0 ? (INTERSECT_COST * bestCost) / parentArea : INTERSECT_COST * cnt)
        : Infinity;
    if (cnt <= maxLeaf && splitCost >= leafCost) {
      makeLeaf();
      continue;
    }
    let mid: number;
    if (bestAxis >= 0) {
      // partition [start, end) by bin
      const ext = cext[bestAxis];
      const scale = BINS / ext;
      const c0 = cmin[bestAxis];
      for (let i = start; i < end; i++) {
        const p = prims[i];
        let b = Math.floor((cent[p * 3 + bestAxis] - c0) * scale);
        if (b >= BINS) b = BINS - 1;
        else if (b < 0) b = 0;
        binOf[i] = b < bestSplit ? 1 : 0;
      }
      let i = start;
      let j = end - 1;
      while (i <= j) {
        if (binOf[i]) i++;
        else {
          const t = prims[i];
          prims[i] = prims[j];
          prims[j] = t;
          const f = binOf[i];
          binOf[i] = binOf[j];
          binOf[j] = f;
          j--;
        }
      }
      mid = i;
      if (mid === start || mid === end) mid = (start + end) >>> 1;
    } else {
      // identical centroids: split by count
      if (cnt <= maxLeaf) {
        makeLeaf();
        continue;
      }
      mid = (start + end) >>> 1;
    }
    const left = nodeCount;
    nodeCount += 2;
    child[node] = left;
    count[node] = 0;
    stack.push(left + 1, mid, end, depth + 1, left, start, mid, depth + 1);
  }
  // Pad node boxes by a tiny relative margin: rays lying exactly in a box face plane (axis-parallel
  // directions, where slab tests degenerate) still enter the box. Parents keep containing children
  // because the margin grows with the coordinates' magnitude.
  for (let i = 0; i < nodeCount; i++) {
    const o = i * 6;
    let m = 0;
    for (let k = 0; k < 6; k++) {
      const v = Math.abs(bounds[o + k]);
      if (v > m && v < Infinity) m = v;
    }
    const pad = 1e-9 * (1 + m);
    bounds[o] -= pad;
    bounds[o + 1] -= pad;
    bounds[o + 2] -= pad;
    bounds[o + 3] += pad;
    bounds[o + 4] += pad;
    bounds[o + 5] += pad;
  }
  return {
    nodeCount,
    depth: maxDepth,
    bounds: bounds.slice(0, nodeCount * 6),
    child: child.slice(0, nodeCount),
    count: count.slice(0, nodeCount),
    prims,
  };
}

/** Number of leaves and maximum depth (for diagnostics and tests). */
export function bvhStats(bvh: BVH): { leaves: number; depth: number; maxLeafSize: number } {
  let leaves = 0;
  let depth = 0;
  let maxLeafSize = 0;
  const stack: number[] = [0, 0];
  while (stack.length) {
    const d = stack.pop()!;
    const node = stack.pop()!;
    if (d > depth) depth = d;
    if (bvh.count[node] > 0 || bvh.nodeCount === 1) {
      leaves++;
      if (bvh.count[node] > maxLeafSize) maxLeafSize = bvh.count[node];
    } else stack.push(bvh.child[node], d + 1, bvh.child[node] + 1, d + 1);
  }
  return { leaves, depth, maxLeafSize };
}
