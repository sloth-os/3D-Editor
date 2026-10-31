import type { Mat4 } from '../math/types';
import type { ConstraintData, ObjectData } from '../doc/types';
import { getConstraintTypeInfo } from './catalogue';
import { parseConstraintParams } from './solve';

/*
 * Object-level dependency graph of one evaluated frame: which object world matrices the world
 * matrix of every object reads through its parent (bone parents read the armature object) and the
 * targets of its object constraints (bone sub-targets read the armature object).
 *
 * It serves two purposes:
 * - Cycle detection. An object constraint whose target depends on its owner (directly, through
 *   other constraints or through parenting) lies on a dependency cycle. Every such constraint is
 *   reported and skipped without reading its target, so results never depend on the order objects
 *   are evaluated in (i.e. on their names), and operators that evaluate a single object report
 *   exactly what the scene evaluator shows.
 * - Evaluation order. Dependencies are handed out before their dependents (iterative depth-first
 *   walk), so long parent / constraint chains are evaluated without deep recursion.
 *
 * Relations inside armature poses (bone constraints, IK) are resolved bone by bone by pose
 * evaluation, which detects its own cycles; they are not part of this graph.
 */

/** What the dependency analysis reads from a per-frame scene state (`FrameState` provides it). */
export interface DependencySource {
  /** Animated objects by id. */
  readonly byId: ReadonlyMap<string, ObjectData>;
  /** World matrices replaced by a simulation: those objects do not evaluate their constraints. */
  readonly simulated?: ReadonlyMap<string, Mat4> | null;
}

interface Edge {
  to: number;
  /** Relation shown in cycle messages: 'parent', a constraint name … */
  label: string;
  /** Object constraint creating the edge (null for parenting). */
  constraint: ConstraintData | null;
  /** The constraint lies on a dependency cycle: evaluation never follows this edge. */
  cyclic: boolean;
}

interface CycleInfo {
  owner: number;
  edge: Edge;
  message?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Whether `solveConstraints` evaluates an object constraint entry (and so reads its target). */
function isEvaluated(c: Record<string, unknown>): boolean {
  if (c.mute === true) return false;
  const info = getConstraintTypeInfo(String(c.type));
  if (!info || info.boneOnly) return false;
  const influence = c.influence;
  if (influence !== undefined && !(typeof influence === 'number' && Number.isFinite(influence) && influence > 0))
    return false;
  return parseConstraintParams(c as unknown as ConstraintData).ok;
}

/** Tarjan's strongly connected components (iterative); returns the component of every node. */
function stronglyConnected(edges: readonly Edge[][]): Int32Array {
  const n = edges.length;
  const order = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const comp = new Int32Array(n).fill(-1);
  const onStack = new Uint8Array(n);
  const next = new Int32Array(n);
  const stack: number[] = [];
  const work: number[] = [];
  let counter = 0;
  let comps = 0;
  for (let root = 0; root < n; root++) {
    if (order[root] !== -1) continue;
    work.push(root);
    while (work.length) {
      const v = work[work.length - 1];
      if (order[v] === -1) {
        order[v] = low[v] = counter++;
        stack.push(v);
        onStack[v] = 1;
      }
      const out = edges[v];
      if (next[v] < out.length) {
        const w = out[next[v]++].to;
        if (order[w] === -1) work.push(w);
        else if (onStack[w]) low[v] = Math.min(low[v], order[w]);
        continue;
      }
      work.pop();
      if (work.length) {
        const u = work[work.length - 1];
        low[u] = Math.min(low[u], low[v]);
      }
      if (low[v] === order[v]) {
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          comp[w] = comps;
        } while (w !== v);
        comps++;
      }
    }
  }
  return comp;
}

/** Most relations listed in a cycle message before it is shortened. */
const MAX_LISTED = 8;
/**
 * Most objects visited while looking for the relations of a cycle message (bounds the cost of
 * huge cycles, which get a summary message instead).
 */
const PATH_SEARCH_LIMIT = 64;

/** See the module comment. Get it with `dependencyGraph(src)` (built once per source). */
export class ConstraintDependencyGraph {
  /** Object id of every node. */
  private readonly ids: string[] = [];
  private readonly index = new Map<string, number>();
  private readonly edges: Edge[][] = [];
  private readonly cycles = new Map<ConstraintData, CycleInfo>();
  private readonly cyclesById = new Map<string, Map<string, CycleInfo>>();
  /** Strongly connected component of every node, and the number of objects in each component. */
  private readonly comp: Int32Array;
  private readonly compSize: Int32Array;
  /** Nodes handed out by `evaluationOrder` (evaluated or being evaluated). */
  private readonly seen: Uint8Array;

  constructor(private readonly src: DependencySource) {
    for (const id of src.byId.keys()) {
      this.index.set(id, this.ids.length);
      this.ids.push(id);
      this.edges.push([]);
    }
    for (const [id, o] of src.byId) this.addRelations(id, o);
    this.comp = stronglyConnected(this.edges);
    this.compSize = new Int32Array(this.ids.length);
    for (const c of this.comp) this.compSize[c]++;
    this.edges.forEach((out, u) => {
      for (const e of out) {
        if (!e.constraint || this.comp[u] !== this.comp[e.to]) continue;
        e.cyclic = true;
        if (this.cycles.has(e.constraint)) continue;
        const info: CycleInfo = { owner: u, edge: e };
        this.cycles.set(e.constraint, info);
        const cid = e.constraint.id;
        if (!isId(cid)) continue;
        let byOwner = this.cyclesById.get(this.ids[u]);
        if (!byOwner) this.cyclesById.set(this.ids[u], (byOwner = new Map()));
        if (!byOwner.has(cid)) byOwner.set(cid, info);
      }
    });
    this.seen = new Uint8Array(this.ids.length);
  }

  private addRelations(id: string, o: ObjectData) {
    const w = this.index.get(id)!;
    const parent = o.parent;
    if (isId(parent) && parent !== id && this.index.has(parent)) {
      const bone = o.parent_type === 'BONE' && isId(o.parent_bone) ? ` bone '${o.parent_bone}'` : '';
      this.link(w, this.index.get(parent)!, `parent${bone}`, null);
    }
    if (this.src.simulated?.has(id) || !Array.isArray(o.constraints)) return;
    for (const c of o.constraints as unknown[]) {
      if (!isRecord(c) || !isEvaluated(c)) continue;
      const t = c.target;
      const tw = isId(t) && t !== id ? this.index.get(t) : undefined;
      if (tw === undefined) continue;
      const name = isId(c.name) ? c.name : String(c.type);
      this.link(w, tw, isId(c.subtarget) ? `${name}, bone '${c.subtarget}'` : name, c as unknown as ConstraintData);
    }
  }

  private link(from: number, to: number, label: string, constraint: ConstraintData | null) {
    this.edges[from].push({ to, label, constraint, cyclic: false });
  }

  /**
   * Why constraint `c` of object `ownerId` cannot be evaluated because it lies on a dependency
   * cycle (e.g. "Target 'B' is part of a dependency cycle: A [Track To] → B [Track To] → A"), or
   * null. Constraints are matched by identity (the entries of the source's objects), else by id.
   */
  cycle(ownerId: string, c: ConstraintData): string | null {
    let info = this.cycles.get(c);
    if (!info && isRecord(c) && isId(c.id)) info = this.cyclesById.get(ownerId)?.get(c.id);
    if (!info || this.ids[info.owner] !== ownerId) return null;
    return (info.message ??= this.describe(info));
  }

  /** Every object constraint on a dependency cycle, with its message (diagnostics, tests). */
  cyclicConstraints(): { object: string; constraint: ConstraintData; message: string }[] {
    return [...this.cycles.entries()].map(([constraint, info]) => ({
      object: this.ids[info.owner],
      constraint,
      message: (info.message ??= this.describe(info)),
    }));
  }

  /**
   * Objects that object `id` depends on (through relations evaluation follows) and that were not
   * handed out before, dependencies first, excluding `id`. The caller evaluates them in this order
   * (each then finds its own dependencies already evaluated) and then `id` itself.
   */
  evaluationOrder(id: string): string[] {
    const start = this.index.get(id);
    if (start === undefined || this.seen[start]) return [];
    const out: string[] = [];
    const stack = [start];
    const pos = [0];
    this.seen[start] = 1;
    while (stack.length) {
      const top = stack.length - 1;
      const edges = this.edges[stack[top]];
      if (pos[top] < edges.length) {
        const e = edges[pos[top]++];
        if (!e.cyclic && !this.seen[e.to]) {
          this.seen[e.to] = 1;
          stack.push(e.to);
          pos.push(0);
        }
        continue;
      }
      const v = stack.pop()!;
      pos.pop();
      if (v !== start) out.push(this.ids[v]);
    }
    return out;
  }

  private nameOf(node: number): string {
    return this.src.byId.get(this.ids[node])?.name ?? this.ids[node];
  }

  /** Message of a cyclic constraint, listing the relations of one cycle through it. */
  private describe(info: CycleInfo): string {
    const head = `Target '${this.nameOf(info.edge.to)}' is part of a dependency cycle`;
    const path = this.pathBack(info.edge.to, info.owner);
    if (!path) {
      const count = this.compSize[this.comp[info.owner]];
      return `${head} (a loop through ${count} objects, including '${this.nameOf(info.owner)}')`;
    }
    const hops = [{ from: info.owner, label: info.edge.label }, ...path];
    const parts = hops.map((h) => `${this.nameOf(h.from)} [${h.label}]`);
    const listed =
      parts.length > MAX_LISTED
        ? [...parts.slice(0, MAX_LISTED - 3), `… ${parts.length - MAX_LISTED + 1} more …`, ...parts.slice(-2)]
        : parts;
    return `${head}: ${[...listed, this.nameOf(info.owner)].join(' → ')}`;
  }

  /** Shortest path of relations from node `from` back to node `to` (null if not found quickly). */
  private pathBack(from: number, to: number): { from: number; label: string }[] | null {
    const comp = this.comp[to];
    const prev = new Map<number, { node: number; label: string }>([[from, { node: -1, label: '' }]]);
    const queue = [from];
    for (let i = 0; i < queue.length && !prev.has(to) && prev.size < PATH_SEARCH_LIMIT; i++)
      for (const e of this.edges[queue[i]]) {
        if (this.comp[e.to] !== comp || prev.has(e.to)) continue;
        prev.set(e.to, { node: queue[i], label: e.label });
        queue.push(e.to);
      }
    if (!prev.has(to)) return null;
    const out: { from: number; label: string }[] = [];
    for (let v = to; v !== from; ) {
      const p = prev.get(v)!;
      out.push({ from: p.node, label: p.label });
      v = p.node;
    }
    return out.reverse();
  }
}

const graphs = new WeakMap<DependencySource, ConstraintDependencyGraph>();

/** The dependency graph of a per-frame scene state (built on first use, then cached for it). */
export function dependencyGraph(src: DependencySource): ConstraintDependencyGraph {
  let g = graphs.get(src);
  if (!g) graphs.set(src, (g = new ConstraintDependencyGraph(src)));
  return g;
}

/**
 * Whether object `id` lies on a loop of parent links (corrupt data, e.g. two devices parenting two
 * objects to each other at the same time). Evaluation gives such objects an identity parent.
 */
export function inParentLoop(byId: ReadonlyMap<string, ObjectData>, id: string): boolean {
  const seen = new Set<string>();
  let cur: unknown = byId.get(id)?.parent;
  while (isId(cur) && !seen.has(cur)) {
    if (cur === id) return true;
    seen.add(cur);
    const o = byId.get(cur);
    if (!o || o.parent === cur) return false;
    cur = o.parent;
  }
  return false;
}
